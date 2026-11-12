const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(name, deps = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', `${name}.ts`), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, Intl, Date, require: (key) => {
    if (key in deps) return deps[key];
    throw new Error(`Unexpected dependency: ${key}`);
  } };
  vm.runInNewContext(code, context);
  return context.exports;
}
const time = load('attendance-time');
const worked = load('attendance-worked', { './attendance-time': time });
const { calculateMonthlyOvertime, DEFAULT_WORK_SCHEDULE } = load('attendance-overtime', {
  './attendance-time': time, './attendance-worked': worked,
});
const punch = (type, recordedAt, status = 'confirmed') => ({ type, recordedAt, status });
const shift = (entry, lunch, back, exit, status = 'confirmed') => [
  punch('entrada', entry), punch('saida_almoco', lunch),
  punch('retorno_almoco', back), punch('saida', exit, status),
];

test('calculates overnight weekday shift using total work less normal hours', () => {
  const punches = shift('2026-11-10T09:07:20.761Z', '2026-11-10T16:03:27.666Z',
    '2026-11-10T16:51:35.886Z', '2026-11-11T12:02:27.421Z');
  const result = calculateMonthlyOvertime(punches, DEFAULT_WORK_SCHEDULE, false, '2026-11');
  assert.equal(result.confirmedMinutes, 1026);
  assert.deepEqual(JSON.parse(JSON.stringify(result.days)), [
    { date: '2026-11-11', minutes: 482 },
    { date: '2026-11-10', minutes: 544 },
  ]);
});

test('calculates another overnight shift with exact recorded seconds', () => {
  const punches = shift('2026-11-10T09:08:16.665Z', '2026-11-10T16:05:00.782Z',
    '2026-11-10T16:51:28.517Z', '2026-11-11T12:02:39.733Z');
  const result = calculateMonthlyOvertime(punches, DEFAULT_WORK_SCHEDULE, false, '2026-11');
  assert.equal(result.confirmedMinutes, 1027);
});

test('calculates each complete shift separately including early entries and pending', () => {
  const punches = [
    ...shift('2026-11-09T10:00:00Z', '2026-11-09T15:00:00Z', '2026-11-09T16:00:00Z', '2026-11-09T22:00:00Z'),
    ...shift('2026-11-09T23:00:00Z', '2026-11-10T04:00:00Z', '2026-11-10T05:00:00Z', '2026-11-10T10:00:00Z', 'pending'),
  ];
  const result = calculateMonthlyOvertime(punches, DEFAULT_WORK_SCHEDULE, false, '2026-11');
  assert.equal(result.confirmedMinutes, 120);
  assert.equal(result.pendingMinutes, 60);
  assert.equal(result.days.reduce((total, day) => total + day.minutes, 0), 180);
});

test('weekend rules, incomplete shifts and month of entry', () => {
  const saturday = shift('2026-11-07T11:00:00Z', '2026-11-07T15:00:00Z', '2026-11-07T16:00:00Z', '2026-11-07T20:00:00Z');
  assert.equal(calculateMonthlyOvertime(saturday, null, false).confirmedMinutes, 480);
  assert.equal(calculateMonthlyOvertime(saturday, null, true).confirmedMinutes, 240);
  const incomplete = saturday.slice(0, 2);
  assert.equal(calculateMonthlyOvertime(incomplete, null, false).confirmedMinutes, 0);
  const crossMonth = shift('2026-11-30T11:00:00Z', '2026-11-30T16:00:00Z', '2026-11-30T17:00:00Z', '2026-12-01T12:00:00Z');
  assert.equal(calculateMonthlyOvertime(crossMonth, null, false, '2026-11').confirmedMinutes, 900);
  assert.equal(calculateMonthlyOvertime(crossMonth, null, false, '2026-12').confirmedMinutes, 0);
});

test('Saturday-after-noon rule continues through an overnight shift by its entry day', () => {
  const saturday = shift('2026-11-07T14:00:00Z', '2026-11-07T16:00:00Z',
    '2026-11-07T16:30:00Z', '2026-11-08T12:00:00Z');
  const result = calculateMonthlyOvertime(saturday, null, true);
  assert.equal(result.confirmedMinutes, 1170);
  assert.equal(result.days.reduce((total, day) => total + day.minutes, 0), 1170);
});

test('friday shift ending saturday uses friday rule; sunday counts all work', () => {
  const friday = shift('2026-11-13T11:00:00Z', '2026-11-13T16:00:00Z', '2026-11-13T17:00:00Z', '2026-11-14T12:00:00Z');
  assert.equal(calculateMonthlyOvertime(friday, null).confirmedMinutes, 900);
  const sunday = shift('2026-11-08T11:00:00Z', '2026-11-08T15:00:00Z', '2026-11-08T16:00:00Z', '2026-11-08T20:00:00Z');
  assert.equal(calculateMonthlyOvertime(sunday, null).confirmedMinutes, 480);
});
