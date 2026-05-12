/**
 * FamilyHub v5.0.0 — services/rrule-lite.js
 * Lightweight RRULE recurrence engine covering 95% of family patterns.
 * No external dependencies. Drop-in upgradeable to full rrule.js at Phase 3.
 *
 * Public API:
 *   nextDate(rrule, afterISO, fireAt)  — next fire datetime after a point
 *   nextNDates(rrule, fireAt, n)       — preview next N fire datetimes
 *   presetToRrule(preset)              — preset label → RRULE string (null = one-shot)
 *   rruleToHuman(rrule)                — RRULE string → human readable text
 *
 * TIMEZONE RULES (non-negotiable):
 *   - All datetimes are local ISO strings WITHOUT 'Z': "2025-05-12T09:00:00"
 *   - NEVER use toISOString() — it returns UTC and shifts dates in UTC− timezones
 *   - Always use _localISO(date) to build datetime strings
 */

// ── Helpers ───────────────────────────────────────────────── //

function _localISO(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:00`;
}

function _parseLocal(iso) {
  if (!iso) return null;
  const s = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00' : iso;
  return new Date(s);
}

function _extractTime(iso) {
  if (!iso) return { h: 9, m: 0 };
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? { h: parseInt(m[1], 10), m: parseInt(m[2], 10) } : { h: 9, m: 0 };
}

const DAY_MAP   = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── RRULE parser ──────────────────────────────────────────── //

function _parseRrule(rrule) {
  if (!rrule) return null;
  const str = rrule.replace(/^RRULE:/, '');
  const out = {};
  for (const part of str.split(';')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    out[k] = ['BYDAY','BYMONTH','BYMONTHDAY'].includes(k) ? v.split(',') : v;
  }
  return out;
}

// ── Core next-date ─────────────────────────────────────────── //

/**
 * Compute the next fire datetime strictly after `afterISO`.
 * @param {string}      rrule    - RRULE:FREQ=... string
 * @param {string}      afterISO - Current nextFireAt cursor (local ISO)
 * @param {string}      fireAt   - Original fireAt — HH:MM source (local ISO)
 * @returns {string|null}         Next local ISO datetime, or null if exhausted
 */
export function nextDate(rrule, afterISO, fireAt) {
  if (!rrule) return null;
  const rule = _parseRrule(rrule);
  if (!rule?.FREQ) return null;

  const after    = _parseLocal(afterISO);
  const origTime = _extractTime(fireAt || afterISO);
  if (!after || isNaN(after.getTime())) return null;

  const interval = parseInt(rule.INTERVAL || '1', 10);
  let candidate  = null;

  switch (rule.FREQ) {
    case 'MINUTELY': {
      candidate = new Date(after.getTime() + interval * 60000);
      break;
    }
    case 'DAILY': {
      candidate = new Date(after);
      candidate.setDate(candidate.getDate() + interval);
      candidate.setHours(origTime.h, origTime.m, 0, 0);
      break;
    }
    case 'WEEKLY': {
      if (rule.BYDAY?.length > 0) {
        const targetDays = rule.BYDAY
          .map(d => d.replace(/^[+-]?\d+/, ''))
          .map(d => DAY_MAP[d])
          .filter(d => d !== undefined)
          .sort((a, b) => a - b);
        if (!targetDays.length) return null;

        const base = new Date(after);
        base.setSeconds(base.getSeconds() + 1);
        base.setHours(origTime.h, origTime.m, 0, 0);
        // If we set HH:MM backwards past after, advance one day
        if (base <= after) base.setDate(base.getDate() + 1);

        for (let i = 0; i < 14; i++) {
          if (targetDays.includes(base.getDay())) { candidate = new Date(base); break; }
          base.setDate(base.getDate() + 1);
        }

        // H-05 fix: Apply interval > 1 — anchor week alignment to fireAt (original start)
        // NOT to 'after' (Unix epoch relative), which causes biweekly drift between users
        if (candidate && interval > 1) {
          const msPerWeek  = 7 * 86400000;
          const anchor     = fireAt ? _parseLocal(fireAt) : after;
          const anchorWeek = Math.floor((anchor || after).getTime() / msPerWeek);
          const candWeek   = Math.floor(candidate.getTime() / msPerWeek);
          const rem        = (candWeek - anchorWeek) % interval;
          if (rem !== 0) candidate.setDate(candidate.getDate() + (interval - rem) * 7);
        }
      } else {
        candidate = new Date(after);
        candidate.setDate(candidate.getDate() + 7 * interval);
        candidate.setHours(origTime.h, origTime.m, 0, 0);
      }
      break;
    }
    case 'MONTHLY': {
      if (rule.BYDAY?.length > 0) {
        const byDay    = rule.BYDAY[0];
        const posMatch = byDay.match(/^([+-]?\d+)([A-Z]{2})$/);
        if (posMatch) {
          const pos    = parseInt(posMatch[1], 10);
          const dayNum = DAY_MAP[posMatch[2]];
          const tryM   = new Date(after.getFullYear(), after.getMonth(), 1);
          for (let i = 0; i < 24; i++) {
            const found = _nthWeekday(tryM.getFullYear(), tryM.getMonth(), dayNum, pos);
            if (found) {
              found.setHours(origTime.h, origTime.m, 0, 0);
              if (found > after) { candidate = found; break; }
            }
            tryM.setMonth(tryM.getMonth() + interval);
          }
        }
      } else {
        // NEW-H-04 fix: fall through to BYMONTHDAY or same-day-of-month logic
        // RRULE:FREQ=MONTHLY;BYDAY=MO (without position prefix) is technically
        // "every Monday" scoped to month — unsupported in lite engine, fall through
        // to BYMONTHDAY or same-DOM-as-fireAt behavior.
        const dom = rule.BYMONTHDAY ? parseInt(rule.BYMONTHDAY[0], 10) : after.getDate();
        candidate = _advanceMonthly(after, interval, origTime, dom);
      }
      break;
    }
    case 'YEARLY': {
      const targetMonth = rule.BYMONTH ? parseInt(rule.BYMONTH[0], 10) - 1 : after.getMonth();
      const targetDay   = rule.BYMONTHDAY ? parseInt(rule.BYMONTHDAY[0], 10) : after.getDate();
      // C-01 fix: try same year first; only advance if same-year candidate is not strictly after
      candidate = new Date(after.getFullYear(), targetMonth, targetDay, origTime.h, origTime.m, 0, 0);
      if (candidate <= after) {
        // Same year is in the past — advance by interval years
        candidate = new Date(after.getFullYear() + interval, targetMonth, targetDay,
                             origTime.h, origTime.m, 0, 0);
      }
      break;
    }
    default: return null;
  }

  if (!candidate) return null;
  if (rule.UNTIL) {
    const until = _parseLocal(rule.UNTIL);
    if (until && candidate > until) return null;
  }
  return _localISO(candidate);
}

function _nthWeekday(year, month, weekday, pos) {
  if (pos > 0) {
    const first = new Date(year, month, 1);
    const diff  = (weekday - first.getDay() + 7) % 7;
    const day   = 1 + diff + (pos - 1) * 7;
    const result = new Date(year, month, day);
    return result.getMonth() === month ? result : null;
  }
  const last = new Date(year, month + 1, 0);
  const diff = (last.getDay() - weekday + 7) % 7;
  const day  = last.getDate() - diff + (pos + 1) * 7;
  const result = new Date(year, month, day);
  return result.getMonth() === month ? result : null;
}

function _advanceMonthly(after, interval, origTime, dom) {
  const c = new Date(after);
  c.setDate(1);
  c.setMonth(c.getMonth() + interval);
  const lastDay = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
  c.setDate(Math.min(dom, lastDay));
  c.setHours(origTime.h, origTime.m, 0, 0);
  return c > after ? c : null;
}

// ── Preview ───────────────────────────────────────────────── //

export function nextNDates(rrule, fireAt, n = 5) {
  if (!rrule) return fireAt ? [fireAt] : [];
  const results = [];
  let cursor = fireAt;
  for (let i = 0; i < n * 4 && results.length < n; i++) {
    const next = nextDate(rrule, cursor, fireAt);
    if (!next) break;
    results.push(next);
    cursor = next;
  }
  return results;
}

// ── Presets ───────────────────────────────────────────────── //

const PRESETS = {
  'one-time':             null,
  'daily':                'RRULE:FREQ=DAILY',
  'weekdays':             'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  'weekends':             'RRULE:FREQ=WEEKLY;BYDAY=SA,SU',
  'weekly':               'RRULE:FREQ=WEEKLY',
  'biweekly':             'RRULE:FREQ=WEEKLY;INTERVAL=2',
  'monthly':              'RRULE:FREQ=MONTHLY',
  'monthly-first-monday': 'RRULE:FREQ=MONTHLY;BYDAY=1MO',
  'yearly':               'RRULE:FREQ=YEARLY',
  'every-30-min':         'RRULE:FREQ=MINUTELY;INTERVAL=30',
  'hourly':               'RRULE:FREQ=MINUTELY;INTERVAL=60',
};

export function presetToRrule(preset) {
  return Object.prototype.hasOwnProperty.call(PRESETS, preset) ? PRESETS[preset] : null;
}

// ── Human readable ────────────────────────────────────────── //

export function rruleToHuman(rrule) {
  if (!rrule) return 'Does not repeat';
  const rule = _parseRrule(rrule);
  if (!rule) return rrule;
  const interval = parseInt(rule.INTERVAL || '1', 10);

  switch (rule.FREQ) {
    case 'MINUTELY': {
      const m = parseInt(rule.INTERVAL || '1', 10);
      return m === 60 ? 'Every hour' : `Every ${m} minutes`;
    }
    case 'DAILY':
      return interval === 1 ? 'Daily' : `Every ${interval} days`;
    case 'WEEKLY': {
      if (rule.BYDAY) {
        const days = rule.BYDAY
          .map(d => d.replace(/^[+-]?\d+/, ''))
          .map(d => DAY_NAMES[DAY_MAP[d]])
          .filter(Boolean);
        if (days.length === 5 && !rule.BYDAY.some(d => ['SA','SU'].includes(d)))
          return interval === 1 ? 'Weekdays (Mon–Fri)' : `Every ${interval} weeks on weekdays`;
        if (days.length === 2 && rule.BYDAY.every(d => ['SA','SU'].includes(d))) return 'Weekends';
        const joined = days.length > 1 ? days.slice(0,-1).join(', ') + ' & ' + days.at(-1) : days[0];
        return interval === 1 ? `Weekly on ${joined}` : `Every ${interval} weeks on ${joined}`;
      }
      return interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
    }
    case 'MONTHLY': {
      if (rule.BYDAY?.[0]) {
        const m = rule.BYDAY[0].match(/^([+-]?\d+)([A-Z]{2})$/);
        if (m) {
          const pos = parseInt(m[1], 10);
          const day = DAY_NAMES[DAY_MAP[m[2]]];
          const ord = ['','1st','2nd','3rd','4th','5th'][pos] || `${pos}th`;
          return `${ord} ${day} of each month`;
        }
      }
      return interval === 1 ? 'Monthly' : `Every ${interval} months`;
    }
    case 'YEARLY':
      return interval === 1 ? 'Annually' : `Every ${interval} years`;
    default: return rrule;
  }
}
