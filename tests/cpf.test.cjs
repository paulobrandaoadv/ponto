const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cpf.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {} };
vm.runInNewContext(compiled, context);
const { formatCpfInput, displayCpf, cpfSearchPattern, sameCpf } = context.exports;

test('formats CPF progressively and handles pasted input', () => {
  assert.equal(formatCpfInput('123'), '123');
  assert.equal(formatCpfInput('1234'), '123.4');
  assert.equal(formatCpfInput('1234567'), '123.456.7');
  assert.equal(formatCpfInput('12345678901'), '123.456.789-01');
  assert.equal(formatCpfInput('123.456.789-01'), '123.456.789-01');
  assert.equal(formatCpfInput('123456789012'), '123.456.789-01');
});

test('formats only complete legacy CPFs and compares punctuation variants', () => {
  assert.equal(displayCpf('12345678901'), '123.456.789-01');
  assert.equal(displayCpf('12333'), '12333');
  assert.equal(displayCpf('123456789012'), '123456789012');
  assert.equal(cpfSearchPattern('123.456.789-01'), '%1%2%3%4%5%6%7%8%9%0%1%');
  assert.equal(sameCpf('123.456.789-01', '12345678901'), true);
  assert.equal(sameCpf('123.456.789-01', '012345678901'), false);
  assert.equal(sameCpf('12333', '12333'), true);
});
