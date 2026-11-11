const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(name, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', `${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, Intl, Date, require: (key) => {
    if (key in dependencies) return dependencies[key];
    throw new Error(`Unexpected dependency: ${key}`);
  } };
  vm.runInNewContext(compiled, context);
  return context.exports;
}

const time = load('attendance-time');
const { calculateWorkedHours } = load('attendance-worked', { './attendance-time': time });
const punch = (type, recordedAt, status = 'confirmed') => ({ type, recordedAt, status });
const plain = (value) => JSON.parse(JSON.stringify(value));

test('calculates overnight shifts in full, subtracting the break and grouping by entry day', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-10T11:00:00Z'),
    punch('saida_almoco', '2026-11-10T16:00:00Z'),
    punch('retorno_almoco', '2026-11-10T17:00:00Z', 'pending'),
    punch('saida', '2026-11-11T13:00:00Z'),
  ], new Date('2026-11-11T14:00:00Z'));
  assert.equal(result.totalMinutes, 1500);
  assert.deepEqual(plain(result.days), [{ date: '2026-11-10', minutes: 1500 }]);
  assert.equal(result.nextEvent, 'entrada');
  assert.equal(result.incomplete, 0);
});

test('does not count incomplete, rejected, out-of-order or overlong shifts', () => {
  const result = calculateWorkedHours([
    punch('entrada', '2026-11-01T11:00:00Z'),
    punch('saida_almoco', '2026-11-01T16:00:00Z'),
    punch('retorno_almoco', '2026-11-01T17:00:00Z'),
    punch('saida', '2026-11-01T23:00:00Z', 'rejected'),
    punch('entrada', '2026-11-04T11:00:00Z'),
    punch('saida_almoco', '2026-11-04T16:00:00Z'),
    punch('retorno_almoco', '2026-11-04T17:00:00Z'),
    punch('saida', '2026-11-06T12:00:00Z'),
  ]);
  assert.equal(result.totalMinutes, 0);
  assert.equal(result.incomplete, 2);
});

test('continues a shift across midnight and blocks it after 48 hours', () => {
  const punches = [
    punch('entrada', '2026-11-10T11:00:00Z'),
    punch('saida_almoco', '2026-11-10T16:00:00Z'),
    punch('retorno_almoco', '2026-11-10T17:00:00Z'),
  ];
  const active = calculateWorkedHours(punches, new Date('2026-11-11T13:00:00Z'));
  assert.equal(active.nextEvent, 'saida');
  assert.equal(active.inProgress, true);
  assert.equal(active.incomplete, 0);
  const expired = calculateWorkedHours(punches, new Date('2026-11-12T11:00:01Z'));
  assert.equal(expired.nextEvent, null);
  assert.equal(expired.expired, true);
  assert.equal(expired.totalMinutes, 0);
});
