const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

class FaceRecognitionError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}
const timers = new Map();
let nextTimer = 0;
const context = {
  exports: {},
  require: () => ({ FaceRecognitionError }),
  setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
  clearTimeout: (id) => timers.delete(id),
};
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'automatic-face-capture.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const { startAutomaticFaceCapture } = context.exports;
async function tick() {
  const [id, callback] = timers.entries().next().value;
  timers.delete(id);
  await callback();
}

test('local positioning errors retry without sending a recognition attempt', async () => {
  let captures = 0;
  let verifications = 0;
  const guidance = [];
  const stop = startAutomaticFaceCapture(async () => {
    captures++;
    if (captures === 1) throw new FaceRecognitionError('Aproxime o rosto', 'low-quality');
    return [1];
  }, async () => { verifications++; }, (text) => guidance.push(text), assert.fail);
  await tick();
  assert.equal(verifications, 0);
  assert.deepEqual(guidance, ['Aproxime o rosto']);
  await tick();
  assert.equal(verifications, 1);
  stop();
  assert.equal(timers.size, 0);
});

test('does not overlap attempts and stops after unmount during capture', async () => {
  let finish;
  let verifications = 0;
  const stop = startAutomaticFaceCapture(() => new Promise((resolve) => { finish = resolve; }),
    async () => { verifications++; }, assert.fail, assert.fail);
  const pending = tick();
  assert.equal(timers.size, 0);
  stop();
  finish([1]);
  await pending;
  assert.equal(verifications, 0);
  assert.equal(timers.size, 0);
});

test('waits for verification and does not retry after cancellation', async () => {
  let finish;
  let captures = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const stop = startAutomaticFaceCapture(async () => { captures++; return [1]; },
    () => new Promise((resolve) => { finish = resolve; markStarted(); }), assert.fail, assert.fail);
  const pending = tick();
  await started;
  assert.equal(captures, 1);
  assert.equal(timers.size, 0);
  stop();
  finish();
  await pending;
  assert.equal(timers.size, 0);
});

test('fatal errors stop automatic retries and are reported', async () => {
  let reported;
  startAutomaticFaceCapture(async () => { throw new FaceRecognitionError('modelo indisponível', 'model'); },
    assert.fail, assert.fail, (error) => { reported = error; });
  await tick();
  assert.equal(reported.message, 'modelo indisponível');
  assert.equal(timers.size, 0);
});
