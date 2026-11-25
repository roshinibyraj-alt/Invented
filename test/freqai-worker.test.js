'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const FreqAIWorker = require('../freqai-worker');

test('reads and normalizes an atomic current-window FreqAI prediction', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-freqai-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = 1_800_000_090_000;
  const predictionPath = path.join(dataDir, 'freqai', 'latest-prediction.json');
  fs.mkdirSync(path.dirname(predictionPath), { recursive: true });
  fs.writeFileSync(predictionPath, JSON.stringify({
    doPredict: true,
    pUp: 2,
    pDown: 3,
    candleStart: 1_800_000_000_000,
    candleCloseAt: 1_800_000_060_000,
    windowStart: 1_800_000_000_000,
    writtenAt: now,
  }));

  const worker = new FreqAIWorker({ dataDir, now: () => now });
  const state = worker.snapshot();

  assert.equal(state.status, 'READY');
  assert.equal(state.lastPrediction.side, 'DOWN');
  assert.equal(state.lastPrediction.pUp, 0.4);
  assert.equal(state.lastPrediction.pDown, 0.6);
  worker.stop();
});
