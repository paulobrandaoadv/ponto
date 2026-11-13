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
const { facePunchOptions, isRetryableFaceAttendanceError } = context.exports;

test('only entry is offered after a completed shift, not when a shift crosses midnight', () => {
  assert.deepEqual(Array.from(facePunchOptions('saida')), ['entrada']);
  assert.deepEqual(Array.from(facePunchOptions('retorno_almoco')), ['entrada', 'saida_almoco', 'retorno_almoco', 'saida']);
  assert.deepEqual(Array.from(facePunchOptions(null)), ['entrada', 'saida_almoco', 'retorno_almoco', 'saida']);
});

test('only recognized server-side punch rejections allow choosing another facial punch', () => {
  assert.equal(isRetryableFaceAttendanceError({
    code: 'P0001',
    message: 'Já existe uma jornada aberta. Não é possível registrar outra entrada. Se necessário, solicite a revisão ao administrador.',
  }), true);
  assert.equal(isRetryableFaceAttendanceError({
    code: 'P0001',
    message: 'A última marcação já é deste tipo. Não é possível registrá-la novamente em sequência. Se necessário, solicite a revisão ao administrador.',
  }), true);
  assert.equal(isRetryableFaceAttendanceError({
    code: 'P0001',
    message: 'A jornada anterior foi encerrada. A próxima marcação deve ser uma entrada.',
  }), true);
  assert.equal(isRetryableFaceAttendanceError({ code: 'P0001', message: 'A verificação facial expirou.' }), false);
  assert.equal(isRetryableFaceAttendanceError({ code: 'NETWORK_ERROR', message: 'Já existe uma jornada aberta. Não é possível registrar outra entrada.' }), false);
  assert.equal(isRetryableFaceAttendanceError(null), false);
});
