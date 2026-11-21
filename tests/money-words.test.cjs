const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'money-words.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {}, Error };
vm.runInNewContext(code, context);

test('writes receipt amounts in Brazilian Portuguese', () => {
  const { receiptMoneyWords } = context.exports;
  assert.equal(receiptMoneyWords(1), 'um centavo');
  assert.equal(receiptMoneyWords(100), 'um real');
  assert.equal(receiptMoneyWords(10001), 'cem reais e um centavo');
  assert.equal(receiptMoneyWords(123456), 'mil duzentos e trinta e quatro reais e cinquenta e seis centavos');
  assert.equal(receiptMoneyWords(100000000), 'um milhão de reais');
  assert.equal(receiptMoneyWords(100100000), 'um milhão e mil reais');
  assert.throws(() => receiptMoneyWords(0), /inválido/);
  assert.throws(() => receiptMoneyWords(1000000000), /inválido/);
});
