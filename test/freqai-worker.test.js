'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const FreqAIWorker = require('../freqai-worker');

test('reads and normalizes an atomic current-window FreqAI prediction', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-freqai-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = 1_800_000_150_000;
  const predictionPath = path.join(dataDir, 'freqai', 'latest-prediction.json');
  fs.mkdirSync(path.dirname(predictionPath), { recursive: true });
  fs.writeFileSync(predictionPath, JSON.stringify({
    doPredict: true,
    pUp: 2,
    pDown: 3,
    candleStart: 1_800_000_060_000,
    candleCloseAt: 1_800_000_120_000,
    windowStart: 1_800_000_000_000,
    writtenAt: now,
  }));

  const worker = new FreqAIWorker({ dataDir, now: () => now });
  const state = worker.snapshot();

  assert.equal(state.status, 'READY');
  assert.equal(state.lastPrediction.side, 'DOWN');
  assert.equal(state.lastPrediction.pUp, 0.4);
  assert.equal(state.lastPrediction.pDown, 0.6);
  assert.equal(state.lastClosedPrediction.pUp, 0.4);
  worker.stop();
});

test('anchors five-second scores to the closed minute and applies only intraminute score change', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-freqai-intrabar-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = 1_800_000_090_000;
  const predictionPath = path.join(dataDir, 'freqai', 'latest-prediction.json');
  fs.mkdirSync(path.dirname(predictionPath), { recursive: true });
  const raw = { doPredict: true, pUp: .63, pDown: .37,
    candleStart: 1_800_000_063_828, candleCloseAt: 1_800_000_123_828,
    windowStart: 1_800_000_000_000, writtenAt: now, observedAt: now, provisional: true };
  raw.closedPrediction = {
    doPredict: true, pUp: .6, pDown: .4,
    candleStart: 1_800_000_000_000, candleCloseAt: 1_800_000_060_000,
    windowStart: 1_800_000_000_000, writtenAt: now, observedAt: 1_800_000_060_000,
    provisional: false,
  };
  fs.writeFileSync(predictionPath, JSON.stringify(raw));
  const worker = new FreqAIWorker({ dataDir, now: () => now });
  let state = worker.snapshot();
  assert.equal(state.status, 'READY');
  assert.equal(state.lastPrediction.provisional, true);
  assert.equal(state.lastPrediction.observedAt, now);
  assert.equal(state.lastPrediction.adjustmentReady, true);
  assert.equal(state.lastPrediction.pUp, .6);
  assert.equal(state.lastPrediction.rawPUp, .63);
  assert.equal(state.lastPrediction.candleStart, 1_800_000_060_000);
  assert.equal(state.lastPrediction.candleCloseAt, 1_800_000_120_000);
  assert.match(state.scoreCadence, /five-second/);

  raw.pUp = .68; raw.pDown = .32; raw.writtenAt = now + 5_000; raw.observedAt = now + 5_000;
  now += 5_000;
  fs.writeFileSync(predictionPath, JSON.stringify(raw));
  state = worker.snapshot();
  assert.equal(state.lastPrediction.pUp, .65);
  assert.equal(state.lastPrediction.pDown, .35);
  assert.ok(Math.abs(state.scoreAdjustment.deltaPUp - .05) < 1e-12);
  assert.equal(state.scoreHistory.length, 2);

  raw.pUp = .50; raw.pDown = .50; raw.writtenAt = now + 5_000; raw.observedAt = now + 5_000;
  now += 5_000;
  fs.writeFileSync(predictionPath, JSON.stringify(raw));
  state = worker.snapshot();
  assert.ok(Math.abs(state.lastPrediction.pUp - .47) < 1e-12);
  assert.ok(Math.abs(state.lastPrediction.pDown - .53) < 1e-12);
  assert.equal(state.scoreHistory.length, 3);

  now = 1_800_000_125_000;
  raw.pUp = .51; raw.pDown = .49; raw.candleStart = 1_800_000_120_000;
  raw.windowStart = 1_800_000_000_000; raw.writtenAt = now; raw.observedAt = now;
  raw.closedPrediction = {
    doPredict: true, pUp: .58, pDown: .42,
    candleStart: 1_800_000_060_000, candleCloseAt: 1_800_000_120_000,
    windowStart: 1_800_000_000_000, writtenAt: now, observedAt: 1_800_000_120_000,
    provisional: false,
  };
  fs.writeFileSync(predictionPath, JSON.stringify(raw));
  state = worker.snapshot();
  assert.equal(state.lastPrediction.pUp, .58);
  assert.equal(state.lastPrediction.adjustmentDelta, 0);

  now += 12001;
  state = worker.snapshot();
  assert.equal(state.status, 'STALE');
  worker.stop();
});

test('requires the immediately preceding closed minute from the same five-minute window', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-freqai-baseline-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = 1_800_000_090_000;
  const predictionPath = path.join(dataDir, 'freqai', 'latest-prediction.json');
  fs.mkdirSync(path.dirname(predictionPath), { recursive: true });
  fs.writeFileSync(predictionPath, JSON.stringify({
    doPredict: true, pUp: .8, pDown: .2,
    candleStart: 1_800_000_060_000, candleCloseAt: 1_800_000_120_000,
    windowStart: 1_800_000_000_000, writtenAt: now, observedAt: now, provisional: true,
    closedPrediction: {
      doPredict: true, pUp: .6, pDown: .4,
      candleStart: 1_800_000_000_000, candleCloseAt: 1_800_000_060_000,
      windowStart: 1_799_999_700_000, writtenAt: now, observedAt: now - 30_000,
      provisional: false,
    },
  }));
  const worker = new FreqAIWorker({ dataDir, now: () => now });
  const state = worker.snapshot();
  assert.equal(state.status, 'READY');
  assert.equal(state.lastClosedPrediction.windowStart, 1_799_999_700_000);
  assert.equal(state.lastPrediction, null);
  assert.equal(state.scoreAdjustment.ready, false);
  worker.stop();
});
test('passes the shared live-candle file to the FreqAI Python process', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-freqai-candle-bridge-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let launch;
  const worker = new FreqAIWorker({
    dataDir,
    spawnImpl: (command, args, options) => {
      launch = { command, args, env: options.env };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child;
    },
  });
  worker.start();
  assert.equal(launch.env.FREQAI_INTRABAR_CANDLE_FILE, worker.intrabarCandlePath);
  assert.match(worker.intrabarCandlePath, /freqai[/\\]intrabar-candle\.json$/);
  worker.stop();
});
