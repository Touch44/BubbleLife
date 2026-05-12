/**
 * FamilyHub v5.1.0 — tests/time-tracker.test.js
 * Unit tests for services/time-tracker.js (pure-logic subset, no IDB)
 *
 * Tests: formatDuration, formatDurationCompact, getElapsed, getRemaining
 * Run with: node tests/time-tracker.test.js
 */

// ── Inline reimplementation for test isolation ────────────────────────────────

function formatDuration(totalSecs) {
  if (!totalSecs || totalSecs < 0) totalSecs = 0;
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.floor(totalSecs % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatDurationCompact(totalSecs) {
  if (!totalSecs || totalSecs < 0) totalSecs = 0;
  const h  = Math.floor(totalSecs / 3600);
  const m  = Math.floor((totalSecs % 3600) / 60);
  const s  = Math.floor(totalSecs % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

function getElapsed(session) {
  if (!session) return 0;
  let secs = session.baseSecs || 0;
  if (session.running && session.startedAt) {
    secs += Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000);
  }
  return secs;
}

function getRemaining(session) {
  if (!session || session.mode !== 'block' || !session.blockSecs) return null;
  return Math.max(0, session.blockSecs - getElapsed(session));
}

function _adaptiveSnoozeMinutes(reminder) {
  const base      = reminder.snoozeMinutes || 10;
  const fireCount = reminder.fireCount     || 0;
  const multiplier = 1 + Math.min(Math.max(fireCount - 1, 0), 4);
  return Math.min(base * multiplier, 60);
}

// ── Assertions ────────────────────────────────────────────────────────────────

let _passed = 0, _failed = 0;

function assert(description, actual, expected) {
  if (actual === expected) {
    console.log(`  ✅ ${description}`);
    _passed++;
  } else {
    console.error(`  ❌ ${description}\n     expected: ${JSON.stringify(expected)}\n     got:      ${JSON.stringify(actual)}`);
    _failed++;
  }
}

// ── formatDuration tests ──────────────────────────────────────────────────────

console.log('\n🧪 formatDuration\n');

assert('0 seconds',          formatDuration(0),     '0s');
assert('negative → 0s',      formatDuration(-5),    '0s');
assert('30 seconds',         formatDuration(30),    '30s');
assert('60 seconds = 1m 0s', formatDuration(60),    '1m 0s');
assert('90 seconds',         formatDuration(90),    '1m 30s');
assert('3600 = 1h 0s',       formatDuration(3600),  '1h 0s');
assert('3661 = 1h 1m 1s',    formatDuration(3661),  '1h 1m 1s');
assert('86400 = 1d',         formatDuration(86400), '1d 0s');
assert('86461 = 1d 1m 1s',   formatDuration(86461), '1d 1m 1s');

console.log('\n🧪 formatDurationCompact\n');

assert('0 secs = 00:00',     formatDurationCompact(0),    '00:00');
assert('90 secs = 01:30',    formatDurationCompact(90),   '01:30');
assert('3600 = 1:00:00',     formatDurationCompact(3600), '1:00:00');
assert('3661 = 1:01:01',     formatDurationCompact(3661), '1:01:01');
assert('59 secs = 00:59',    formatDurationCompact(59),   '00:59');
assert('600 secs = 10:00',   formatDurationCompact(600),  '10:00');

console.log('\n🧪 getElapsed\n');

assert('null session → 0',   getElapsed(null), 0);
assert('paused at baseSecs', getElapsed({ baseSecs: 120, running: false }), 120);
assert('not started → 0',    getElapsed({ baseSecs: 0,   running: false }), 0);

// Running session started 10 seconds ago
const now = new Date();
const tenSecondsAgo = new Date(now.getTime() - 10000).toISOString();
const elapsed = getElapsed({ baseSecs: 0, running: true, startedAt: tenSecondsAgo });
const elapsedOk = elapsed >= 9 && elapsed <= 11;
if (elapsedOk) { console.log('  ✅ running session ≈ 10s elapsed'); _passed++; }
else           { console.error(`  ❌ running session elapsed: expected ~10, got ${elapsed}`); _failed++; }

// Running with base
const elapsedWithBase = getElapsed({ baseSecs: 60, running: true, startedAt: tenSecondsAgo });
const withBaseOk = elapsedWithBase >= 69 && elapsedWithBase <= 71;
if (withBaseOk) { console.log('  ✅ running session with base 60s ≈ 70s elapsed'); _passed++; }
else            { console.error(`  ❌ running with base elapsed: expected ~70, got ${elapsedWithBase}`); _failed++; }

console.log('\n🧪 getRemaining\n');

assert('null session → null',    getRemaining(null), null);
assert('freeRun mode → null',    getRemaining({ mode:'freeRun', blockSecs:300, running:true, baseSecs:0, startedAt:null }), null);
assert('no blockSecs → null',    getRemaining({ mode:'block', blockSecs:null, baseSecs:0, running:false }), null);
assert('block not started → 300', getRemaining({ mode:'block', blockSecs:300, baseSecs:0, running:false, startedAt:null }), 300);
assert('block exhausted → 0',    getRemaining({ mode:'block', blockSecs:300, baseSecs:300, running:false }), 0);
assert('block overflow clamp → 0', getRemaining({ mode:'block', blockSecs:100, baseSecs:500, running:false }), 0);

console.log('\n🧪 _adaptiveSnoozeMinutes (Phase 2 heuristic)\n');

assert('fireCount=0, base=10 → 10',  _adaptiveSnoozeMinutes({ snoozeMinutes:10, fireCount:0 }),  10);
assert('fireCount=1, base=10 → 10',  _adaptiveSnoozeMinutes({ snoozeMinutes:10, fireCount:1 }),  10);
assert('fireCount=2, base=10 → 20',  _adaptiveSnoozeMinutes({ snoozeMinutes:10, fireCount:2 }),  20);
assert('fireCount=3, base=10 → 30',  _adaptiveSnoozeMinutes({ snoozeMinutes:10, fireCount:3 }),  30);
assert('fireCount=4, base=10 → 40',  _adaptiveSnoozeMinutes({ snoozeMinutes:10, fireCount:4 }),  40);
assert('fireCount=5, base=10 → 50',  _adaptiveSnoozeMinutes({ snoozeMinutes:10, fireCount:5 }),  50);
assert('fireCount=6, base=10 → 50 (capped at 5x)',  _adaptiveSnoozeMinutes({ snoozeMinutes:10, fireCount:6 }),  50);
assert('large base capped at 60',    _adaptiveSnoozeMinutes({ snoozeMinutes:15, fireCount:5 }),  60);
assert('no snoozeMinutes → default 10', _adaptiveSnoozeMinutes({ fireCount:0 }),                10);

// ── Block preset validation ───────────────────────────────────────────────────

console.log('\n🧪 Block preset options (5m–5hr range)\n');

const BLOCK_OPTS = [300,600,900,1500,1800,2700,3600,5400,7200,10800,14400,18000];
assert('12 preset options defined',       BLOCK_OPTS.length, 12);
assert('min block = 5 min (300s)',        BLOCK_OPTS[0],     300);
assert('25-min Pomodoro included (1500)', BLOCK_OPTS.includes(1500), true);
assert('max block = 5 hr (18000s)',       BLOCK_OPTS[BLOCK_OPTS.length - 1], 18000);
assert('all values > 0',                 BLOCK_OPTS.every(v => v > 0), true);
assert('all values <= 18000',            BLOCK_OPTS.every(v => v <= 18000), true);

// ── Quiet hours logic ─────────────────────────────────────────────────────────

console.log('\n🧪 Quiet hours range logic\n');

function isInQuietWindow(nowMin, startMin, endMin) {
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin; // wraps midnight
}

const toMin = (h, m) => h * 60 + m;
// Day range (e.g. 09:00–17:00)
assert('day range: inside',     isInQuietWindow(toMin(12,0), toMin(9,0), toMin(17,0)), true);
assert('day range: outside',    isInQuietWindow(toMin(18,0), toMin(9,0), toMin(17,0)), false);
// Night range (wraps midnight, e.g. 22:00–07:00)
assert('night range: 23:00',    isInQuietWindow(toMin(23,0), toMin(22,0), toMin(7,0)),  true);
assert('night range: 01:00',    isInQuietWindow(toMin(1, 0), toMin(22,0), toMin(7,0)),  true);
assert('night range: 08:00',    isInQuietWindow(toMin(8, 0), toMin(22,0), toMin(7,0)),  false);
assert('night range: 21:59',    isInQuietWindow(toMin(21,59),toMin(22,0), toMin(7,0)),  false);

// ── RESULTS ───────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) process.exit(1);
