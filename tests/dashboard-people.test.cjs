const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-people.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {} };
vm.runInNewContext(compiled, context);
const { dashboardPeople } = context.exports;

test('lists active collaborators, first valid entry per person and late arrivals', () => {
  const employees = [
    { id: '1', name: 'Ana', shift: '07:00-11:30|13:00-17:30', status: 'Ativo' },
    { id: '2', name: 'Bia', shift: '07:00-11:30|13:00-17:30', status: 'Ativo' },
    { id: '3', name: 'Caio', shift: 'Flexível', status: 'Ativo' },
    { id: '4', name: 'Dora', shift: '07:00', status: 'Arquivado' },
    { id: '5', name: 'Eva', shift: '07:00', status: 'Ativo' },
    { id: '6', name: 'Fábio', shift: '07:00', status: 'Férias' },
  ];
  const entry = (employeeId, time, status = 'confirmed', date = '2026-11-11', type = 'entrada') =>
    ({ employeeId, time, status, date, type });
  const result = dashboardPeople(employees, [
    entry('1', '08:00'), entry('1', '06:55', 'pending'), entry('1', '06:00', 'rejected'),
    entry('2', '07:10', 'pending'), entry('3', '10:00'), entry('4', '08:00'),
    entry('2', '06:30', 'confirmed', '2026-11-10'), entry('2', '06:00', 'confirmed', '2026-11-11', 'saida'),
    entry('5', '08:00', 'rejected'), entry('4', '08:00', 'confirmed'),
  ], '2026-11-11');
  assert.deepEqual(Array.from(result.collaborators, (person) => person.name), ['Ana', 'Bia', 'Caio', 'Eva', 'Fábio']);
  assert.deepEqual(Array.from(result.present, (person) => [person.name, person.entryTime]), [['Ana', '06:55'], ['Bia', '07:10'], ['Caio', '10:00']]);
  assert.deepEqual(Array.from(result.late, (person) => [person.name, person.scheduledStart]), [['Bia', '07:00']]);
  assert.deepEqual(Array.from(result.missing, (person) => person.name), ['Eva', 'Fábio']);
});

test('returns empty lists when no employees or entries match', () => {
  const result = dashboardPeople([], [], '2026-11-11');
  assert.equal(result.collaborators.length, 0);
  assert.equal(result.present.length, 0);
  assert.equal(result.late.length, 0);
  assert.equal(result.missing.length, 0);
});
