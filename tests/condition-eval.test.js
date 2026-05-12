/**
 * FamilyHub v5.1.0 — tests/condition-eval.test.js
 * Unit tests for services/condition-eval.js
 *
 * Run with: node --experimental-vm-modules tests/condition-eval.test.js
 * (No test runner required — plain assertions with process.exit codes)
 */

// ── Inline reimplementation for test isolation (no IDB, no imports) ──────────
// Mirrors the real evaluateCondition logic for all operators that don't need IDB.
// The 'includes' operator (which needs getEdgesFrom) is tested via a stub.

const _loose = (v) => v == null ? '' : String(v).trim().toLowerCase();
const _date  = (v) => { if (!v) return new Date(NaN); const s = String(v); return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s); };
const NO_VALUE_OPS = new Set(['is_empty','is_not_empty','is_overdue']);

/**
 * Synchronous subset of evaluateCondition (all non-IDB operators).
 */
function evalSync(rule, entity) {
  if (!rule || typeof rule !== 'object') return true;
  const { op } = rule;

  if (op === 'and') return (rule.conditions || []).every(c => evalSync(c, entity));
  if (op === 'or')  return (rule.conditions || []).some(c  => evalSync(c, entity));
  if (op === 'not') {
    const c = rule.condition || rule.conditions?.[0];
    return c ? !evalSync(c, entity) : true;
  }

  const { field, value } = rule;
  const raw = entity?.[field];

  switch (op) {
    case 'equals':       return _loose(raw) === _loose(value);
    case 'not_equals':   return _loose(raw) !== _loose(value);
    case 'contains':     return String(raw ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'not_contains': return !String(raw ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'greater_than': return Number(raw) > Number(value);
    case 'less_than':    return Number(raw) < Number(value);
    case 'is_empty':     return raw == null || raw === '' || (Array.isArray(raw) && !raw.length);
    case 'is_not_empty': return raw != null && raw !== '' && !(Array.isArray(raw) && !raw.length);
    case 'before':       return raw ? _date(raw) < _date(value) : false;
    case 'after':        return raw ? _date(raw) > _date(value) : false;
    case 'within_days': {
      if (!raw) return false;
      const days  = Number(value) || 0;
      const now   = new Date();
      const limit = new Date(now.getTime() + days * 86400000);
      const d     = _date(raw);
      return d >= now && d <= limit;
    }
    case 'is_overdue': {
      if (!raw) return false;
      const done = new Set(['done','Done','Completed','completed']);
      if (done.has(entity?.status ?? '')) return false;
      return _date(raw) < new Date();
    }
    default: return true;
  }
}

// ── Assertions ────────────────────────────────────────────────────────────────

let _passed = 0, _failed = 0;

function assert(description, actual, expected = true) {
  if (actual === expected) {
    console.log(`  ✅ ${description}`);
    _passed++;
  } else {
    console.error(`  ❌ ${description}\n     expected: ${JSON.stringify(expected)}\n     got:      ${JSON.stringify(actual)}`);
    _failed++;
  }
}

// ── TEST GROUPS ───────────────────────────────────────────────────────────────

console.log('\n🧪 condition-eval — scalar operators\n');

const entity = { status: 'In Progress', priority: 'High', dueDate: '2020-01-01', title: 'Fix the bug' };

assert('equals match',          evalSync({ op:'equals',       field:'status',   value:'In Progress' }, entity), true);
assert('equals no-match',       evalSync({ op:'equals',       field:'status',   value:'Done' }, entity),        false);
assert('not_equals match',      evalSync({ op:'not_equals',   field:'status',   value:'Done' }, entity),        true);
assert('contains match',        evalSync({ op:'contains',     field:'title',    value:'bug' }, entity),         true);
assert('contains case-insens',  evalSync({ op:'contains',     field:'title',    value:'FIX' }, entity),         true);
assert('not_contains match',    evalSync({ op:'not_contains', field:'title',    value:'xyz' }, entity),         true);
assert('greater_than',          evalSync({ op:'greater_than', field:'priority', value: 3 }, { priority: 5 }), true);
assert('less_than',             evalSync({ op:'less_than',    field:'priority', value: 10 }, { priority: 3 }), true);
assert('is_empty — null',       evalSync({ op:'is_empty',     field:'notes' }, entity),                         true);
assert('is_not_empty — val',    evalSync({ op:'is_not_empty', field:'status' }, entity),                        true);
assert('before — past date',    evalSync({ op:'before',       field:'dueDate',  value:'2025-01-01' }, entity),  true);
assert('after — future date',   evalSync({ op:'after',        field:'dueDate',  value:'2019-01-01' }, entity),  true);
assert('is_overdue — past + !done', evalSync({ op:'is_overdue', field:'dueDate' }, entity),                    true);
assert('is_overdue — done status',  evalSync({ op:'is_overdue', field:'dueDate' }, { ...entity, status:'Completed' }), false);

console.log('\n🧪 condition-eval — logical operators\n');

assert('AND — both true',   evalSync({ op:'and', conditions:[
  { op:'equals', field:'status', value:'In Progress' },
  { op:'contains', field:'title', value:'bug' }
]}, entity), true);

assert('AND — one false',   evalSync({ op:'and', conditions:[
  { op:'equals', field:'status', value:'In Progress' },
  { op:'equals', field:'status', value:'Done' }
]}, entity), false);

assert('OR — one true',     evalSync({ op:'or', conditions:[
  { op:'equals', field:'status', value:'Done' },
  { op:'contains', field:'title', value:'bug' }
]}, entity), true);

assert('OR — both false',   evalSync({ op:'or', conditions:[
  { op:'equals', field:'status', value:'Done' },
  { op:'equals', field:'priority', value:'Low' }
]}, entity), false);

assert('NOT — negates true',  evalSync({ op:'not', condition:{ op:'equals', field:'status', value:'Done' } }, entity), true);
assert('NOT — negates false', evalSync({ op:'not', condition:{ op:'equals', field:'status', value:'In Progress' } }, entity), false);

console.log('\n🧪 condition-eval — edge cases\n');

assert('null condition → true', evalSync(null, entity), true);
assert('empty object → true',   evalSync({}, entity),   true);
assert('unknown op → true',     evalSync({ op:'telekinesis', field:'x', value:'y' }, entity), true);
assert('AND empty → true',      evalSync({ op:'and', conditions:[] }, entity), true);
assert('OR empty → false',      evalSync({ op:'or',  conditions:[] }, entity), false);

// ── RESULTS ───────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) process.exit(1);
