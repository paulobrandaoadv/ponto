const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'face-attendance.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {} };
vm.runInNewContext(compiled, context);
const { isDuplicateFaceAttendanceError } = context.exports;

test('only recognized server-side duplicate rejections allow choosing another facial punch', () => {
  assert.equal(isDuplicateFaceAttendanceError({
    code: 'P0001',
    message: 'Já existe uma jornada aberta. Não é possível registrar outra entrada. Se necessário, solicite a revisão ao administrador.',
  }), true);
  assert.equal(isDuplicateFaceAttendanceError({
    code: 'P0001',
    message: 'A última marcação já é deste tipo. Não é possível registrá-la novamente em sequência. Se necessário, solicite a revisão ao administrador.',
  }), true);
  assert.equal(isDuplicateFaceAttendanceError({ code: 'P0001', message: 'A verificação facial expirou.' }), false);
  assert.equal(isDuplicateFaceAttendanceError({ code: 'NETWORK_ERROR', message: 'Já existe uma jornada aberta. Não é possível registrar outra entrada.' }), false);
  assert.equal(isDuplicateFaceAttendanceError(null), false);
});
