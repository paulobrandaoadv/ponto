const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(name, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', `${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, Intl, Date, Error, require: (key) => {
    if (key in dependencies) return dependencies[key];
    throw new Error(`Unexpected dependency: ${key}`);
  } };
  vm.runInNewContext(compiled, context);
  return context.exports;
}

const time = load('attendance-time');
const { calculateWorkedHours, collectWorkShifts } = load('attendance-worked', { './attendance-time': time });
const punch = (type, recordedAt, status = 'confirmed') => ({ type, recordedAt, status });
const plain = (value) => JSON.parse(JSON.stringify(value));

test('one continuous shift crosses midnight, subtracts its break and distributes work by date', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-10T10:00:00Z'),
    punch('saida_almoco', '2026-11-10T16:00:00Z'),
    punch('retorno_almoco', '2026-11-10T16:35:00Z'),
    punch('saida', '2026-11-11T13:00:00Z'),
  ]);
  assert.equal(result.totalMinutes, 1585);
  assert.deepEqual(plain(result.days), [
    { date: '2026-11-11', minutes: 540 },
    { date: '2026-11-10', minutes: 1045 },
  ]);
  assert.equal(collectWorkShifts([
    punch('entrada', '2026-11-10T10:00:00Z'),
    punch('saida_almoco', '2026-11-10T16:00:00Z'),
    punch('retorno_almoco', '2026-11-10T16:35:00Z'),
    punch('saida', '2026-11-11T13:00:00Z'),
  ]).shifts.length, 1);
});

test('a new entry after a previous exit starts a distinct shift', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-10T10:00:00Z'),
    punch('saida_almoco', '2026-11-10T16:00:00Z'),
    punch('retorno_almoco', '2026-11-10T16:35:00Z'),
    punch('saida', '2026-11-11T13:00:00Z'),
    punch('entrada', '2026-11-11T19:00:00Z'),
    punch('saida', '2026-11-11T21:00:00Z'),
  ]);
  assert.equal(result.totalMinutes, 1705);
  assert.equal(collectWorkShifts([
    punch('entrada', '2026-11-10T10:00:00Z'),
    punch('saida', '2026-11-10T18:00:00Z'),
    punch('entrada', '2026-11-10T19:00:00Z'),
    punch('saida', '2026-11-10T21:00:00Z'),
  ]).shifts.length, 2);
  assert.equal(collectWorkShifts([
    punch('entrada', '2026-11-10T10:00:00Z'),
    punch('saida', '2026-11-10T18:00:00Z'),
  ]).state, 'closed');
});

test('overnight shifts need no interval and calculate full date-time duration', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-11T02:00:00Z'),
    punch('saida', '2026-11-11T10:00:00Z'),
  ]);
  assert.equal(result.totalMinutes, 480);
  assert.deepEqual(plain(result.days), [
    { date: '2026-11-11', minutes: 360 },
    { date: '2026-11-10', minutes: 120 },
  ]);
});

test('a short shift over midnight is not lost', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-11T03:50:00Z'),
    punch('saida', '2026-11-11T04:30:00Z'),
  ]);
  assert.equal(result.totalMinutes, 40);
  assert.deepEqual(plain(result.days), [
    { date: '2026-11-11', minutes: 30 },
    { date: '2026-11-10', minutes: 10 },
  ]);
});

test('open shifts over 18 hours remain recordable and are not discarded at 48 hours', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-10T10:00:00Z'),
  ], new Date('2026-11-11T06:30:00Z'));
  assert.equal(result.inProgress, true);
  assert.equal(result.state, 'working');
  assert.equal(result.openHours, 20.5);
  assert.equal(result.totalMinutes, 0);
});

test('consecutive entries are flagged without creating a duplicate session', () => {
  const punches = [
    punch('entrada', '2026-11-10T10:00:00Z'),
    punch('entrada', '2026-11-10T10:01:00Z'),
    punch('saida', '2026-11-10T18:00:00Z'),
  ];
  const result = calculateWorkedHours(punches);
  assert.equal(collectWorkShifts(punches).shifts.length, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.totalMinutes, 480);
});

test('multiple break periods are subtracted and the state returns to working', () => {
  const punches = [
    punch('entrada', '2026-11-10T11:00:00Z'),
    punch('saida_almoco', '2026-11-10T13:00:00Z'),
    punch('retorno_almoco', '2026-11-10T13:15:00Z'),
    punch('saida_almoco', '2026-11-10T15:00:00Z'),
    punch('retorno_almoco', '2026-11-10T15:30:00Z'),
    punch('saida', '2026-11-10T18:00:00Z'),
  ];
  const result = calculateWorkedHours(punches);
  assert.equal(result.totalMinutes, 375);
  assert.equal(result.incomplete, 0);
});

test('pending punches count, rejected punches do not advance the session, and invalid events are preserved as anomalies', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-10T10:00:00Z'),
    punch('saida_almoco', '2026-11-10T14:00:00Z'),
    punch('retorno_almoco', '2026-11-10T14:30:00Z', 'rejected'),
    punch('retorno_almoco', '2026-11-10T15:00:00Z', 'pending'),
    punch('saida', '2026-11-10T19:00:00Z', 'pending'),
  ]);
  assert.equal(result.totalMinutes, 480);
  assert.equal(result.incomplete, 0);
});

test('a long completed shift is retained and split by its real work intervals', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-10T10:00:00Z'),
    punch('saida_almoco', '2026-11-10T16:00:00Z'),
    punch('retorno_almoco', '2026-11-10T16:35:00Z'),
    punch('saida', '2026-11-12T10:00:00Z'),
  ]);
  assert.equal(result.totalMinutes, 2845);
  assert.deepEqual(plain(result.days), [
    { date: '2026-11-12', minutes: 360 },
    { date: '2026-11-11', minutes: 1440 },
    { date: '2026-11-10', minutes: 1045 },
  ]);
});
