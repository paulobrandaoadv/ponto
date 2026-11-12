const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(name, deps = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', `${name}.ts`), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, Intl, Date, Error, require: (key) => {
    if (key in deps) return deps[key];
    throw new Error(`Unexpected dependency: ${key}`);
  } };
  vm.runInNewContext(code, context);
  return context.exports;
}

const time = load('attendance-time');
const worked = load('attendance-worked', { './attendance-time': time });
const overtime = load('attendance-overtime', { './attendance-time': time, './attendance-worked': worked });
const { calculateReportOvertime } = load('report-overtime', {
  './attendance-time': time, './attendance-worked': worked, './attendance-overtime': overtime,
});
const employee = (id, modalidade) => ({
  id, name: id, modalidade, shift: '07:00-11:30|13:00-17:30', saturdayUntilNoon: false,
});
const shift = (employeeId, timestamps, status = 'confirmed') =>
  ['entrada', 'saida_almoco', 'retorno_almoco', 'saida'].map((type, i) => ({
    employeeId, type, recordedAt: timestamps[i], status: i === 3 ? status : 'confirmed',
  }));
const plain = (value) => JSON.parse(JSON.stringify(value));

test('reports totals by employee and entry date, including shifts ending after the period', () => {
  const employees = [employee('mensalista', 'mensalista'), employee('diarista', 'diarista')];
  const punches = [
    ...shift('mensalista', ['2026-11-10T09:00:00Z', '2026-11-10T16:00:00Z', '2026-11-10T17:00:00Z', '2026-11-11T12:00:00Z']),
    ...shift('diarista', ['2026-11-10T11:00:00Z', '2026-11-10T16:00:00Z', '2026-11-10T17:00:00Z', '2026-11-11T13:00:00Z'], 'pending'),
    ...shift('diarista', ['2026-11-11T14:00:00Z', '2026-11-11T16:00:00Z', '2026-11-11T17:00:00Z', '2026-11-11T20:00:00Z']),
  ];
  const result = calculateReportOvertime(employees, punches, '2026-11-10', '2026-11-10');
  assert.equal(result[0].totalMinutes, 1020);
  assert.equal(result[0].pendingMinutes, 0);
  assert.equal(result[1].totalMinutes, 1500);
  assert.equal(result[1].pendingMinutes, 1500);
  assert.deepEqual(plain(result[1].days), [
    { date: '2026-11-11', minutes: 540 },
    { date: '2026-11-10', minutes: 960 },
  ]);
  const nextDay = calculateReportOvertime(employees, punches, '2026-11-11', '2026-11-11');
  assert.equal(nextDay[0].totalMinutes, 0);
  assert.equal(nextDay[1].totalMinutes, 300);
});

test('excludes incomplete and rejected shifts and uses the Campo Grande entry date', () => {
  const punches = [
    ...shift('daily', ['2026-11-10T02:00:00Z', '2026-11-10T04:00:00Z', '2026-11-10T05:00:00Z', '2026-11-10T07:00:00Z']),
    ...shift('daily', ['2026-11-10T11:00:00Z', '2026-11-10T16:00:00Z', '2026-11-10T17:00:00Z', '2026-11-10T20:00:00Z'], 'rejected'),
  ];
  const result = calculateReportOvertime([employee('daily', 'diarista')], punches, '2026-11-10', '2026-11-10');
  assert.equal(result[0].totalMinutes, 0);
  assert.equal(result[0].days.length, 0);
  const previous = calculateReportOvertime([employee('daily', 'diarista')], punches, '2026-11-09', '2026-11-09');
  assert.equal(previous[0].totalMinutes, 240);
});

test('reports invalid schedules and unknown employees instead of silently omitting data', () => {
  const invalid = { ...employee('monthly', 'mensalista'), shift: '17:00-11:30|13:00-07:00' };
  assert.throws(() => calculateReportOvertime([invalid], [], '2026-11-01', '2026-11-30'), /monthly:.*inválida/);
  assert.throws(() => calculateReportOvertime([], [
    { employeeId: 'missing', type: 'entrada', recordedAt: '2026-11-10T11:00:00Z', status: 'confirmed' },
  ], '2026-11-01', '2026-11-30'), /funcionário que não foi carregado/);
});
