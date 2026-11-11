const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'attendance-time.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {}, Intl, Date };
vm.runInNewContext(compiled, context);
const { attendanceDate, attendanceTime, attendanceDateTimeToIso, nextAttendanceDate } = context.exports;

test('uses Campo Grande regardless of the device time zone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['America/Asuncion', 'America/Sao_Paulo', 'UTC']) {
      process.env.TZ = zone;
      const instant = new Date('2026-11-01T03:30:00Z');
      assert.equal(attendanceDate(instant), '2026-10-31');
      assert.equal(attendanceTime(instant), '23:30');
      assert.equal(attendanceDateTimeToIso('2026-11-07', '16:00'), '2026-11-07T20:00:00.000Z');
      assert.equal(attendanceDateTimeToIso('2026-11-01'), '2026-11-01T04:00:00.000Z');
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('calculates report boundaries across month and leap-year changes', () => {
  assert.equal(nextAttendanceDate('2024-02-28'), '2024-02-29');
  assert.equal(nextAttendanceDate('2024-02-29'), '2024-03-01');
  assert.equal(nextAttendanceDate('2026-12-31'), '2027-01-01');
  assert.throws(() => nextAttendanceDate('2026-02-30'));
  assert.throws(() => attendanceDateTimeToIso('2026-02-30', '12:00'));
  assert.throws(() => attendanceDateTimeToIso('2026-11-07', '25:00'));
});
