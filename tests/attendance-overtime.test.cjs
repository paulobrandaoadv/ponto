const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'attendance-overtime.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {}, Intl, Date };
vm.runInNewContext(compiled, context);
const { calculateMonthlyOvertime, DEFAULT_WORK_SCHEDULE } = context.exports;

const punch = (type, recordedAt, status = 'confirmed') => ({ type, recordedAt, status });

test('lists only days with overtime, newest first, matching confirmed and pending totals', () => {
  const result = calculateMonthlyOvertime([
    punch('entrada', '2026-11-07T11:00:00Z'),
    punch('saida_almoco', '2026-11-07T20:00:00Z', 'pending'),
    punch('saida', '2026-11-09T22:30:00Z'),
    punch('saida', '2026-11-10T21:30:00Z'),
    punch('saida', '2026-11-11T23:00:00Z', 'rejected'),
  ], DEFAULT_WORK_SCHEDULE);

  assert.equal(result.confirmedMinutes, 60);
  assert.equal(result.pendingMinutes, 540);
  assert.deepEqual(JSON.parse(JSON.stringify(result.days)), [
    { date: '2026-11-09', minutes: 60 },
    { date: '2026-11-07', minutes: 540 },
  ]);
});

test('uses the attendance time zone and returns no days for an invalid schedule', () => {
  const result = calculateMonthlyOvertime([
    punch('entrada', '2026-11-07T11:00:00Z'),
    punch('saida_almoco', '2026-11-08T01:00:00Z'),
  ], DEFAULT_WORK_SCHEDULE);
  assert.deepEqual(JSON.parse(JSON.stringify(result.days)), [{ date: '2026-11-07', minutes: 840 }]);

  const invalid = calculateMonthlyOvertime([], { ...DEFAULT_WORK_SCHEDULE, end: 'invalid' });
  assert.deepEqual(JSON.parse(JSON.stringify(invalid.days)), []);
});
