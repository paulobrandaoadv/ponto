const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'report-payment.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {}, Error };
vm.runInNewContext(code, context);

test('parses hourly rates in Brazilian and decimal formats', () => {
  const { parseHourlyRateCents } = context.exports;
  assert.equal(parseHourlyRateCents('15,00'), 1500);
  assert.equal(parseHourlyRateCents('R$ 1.234,56'), 123456);
  assert.equal(parseHourlyRateCents('1.234'), 123400);
  assert.equal(parseHourlyRateCents('15.50'), 1550);
  assert.equal(parseHourlyRateCents('0'), null);
  assert.equal(parseHourlyRateCents('15,999'), null);
  assert.equal(parseHourlyRateCents('1.5,00'), null);
  assert.equal(parseHourlyRateCents('12.34,56'), null);
  assert.equal(parseHourlyRateCents('abc'), null);
});

test('calculates report payment from exact minutes and hourly cents', () => {
  const { calculatePaymentCents } = context.exports;
  assert.equal(calculatePaymentCents(105, 1500), 2625);
  assert.equal(calculatePaymentCents(1, 1500), 25);
  assert.throws(() => calculatePaymentCents(-1, 1500), /horas e valor-hora válidos/);
  assert.throws(() => calculatePaymentCents(Number.MAX_SAFE_INTEGER, 1500), /limite permitido/);
});
