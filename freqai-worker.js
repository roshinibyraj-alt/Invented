'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

class FreqAIWorker {
  constructor({
    rootDir = __dirname,
    dataDir = process.env.FREQAI_DATA_DIR
      || (process.env.PAPER_LEDGER_PATH
        ? path.dirname(process.env.PAPER_LEDGER_PATH)
        : path.join(require('node:os').tmpdir(), 'invented-freqai')),
    python = process.env.PYTHON_BIN || 'python3',
    spawnImpl = spawn,
    now = Date.now,
    pollMs = 1000,
    restartMs = 15_000,
  } = {}) {
    this.rootDir = rootDir;
    this.dataDir = dataDir;
    this.userDataDir = path.join(dataDir, 'freqai-user-data');
    this.predictionPath = path.join(dataDir, 'freqai', 'latest-prediction.json');
    this.intrabarCandlePath = path.join(dataDir, 'freqai', 'intrabar-candle.json');
    this.configPath = path.join(rootDir, 'freqai', 'config.json');
    this.strategyPath = path.join(rootDir, 'freqai', 'strategies');
    this.python = python;
    this.spawnImpl = spawnImpl;
    this.now = now;
    this.pollMs = pollMs;
    this.restartMs = restartMs;
    this.child = null;
    this.pollTimer = null;
    this.restartTimer = null;
    this.stopped = true;
    this.lastPrediction = null;
    this.lastError = null;
    this.status = 'STOPPED';
    this.startedAt = null;
    this.restartCount = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.mkdirSync(path.dirname(this.predictionPath), { recursive: true });
      this.status = 'STARTING';
      this.launch();
      this.pollTimer = setInterval(() => this.refreshPrediction(), this.pollMs);
      this.pollTimer.unref?.();
      this.refreshPrediction();
    } catch (error) {
      this.status = 'ERROR';
      this.lastError = error?.message || String(error);
    }
  }

  launch() {
    if (this.stopped || this.child) return;
    const args = [
      '-m', 'freqtrade', 'trade',
      '--config', this.configPath,
      '--userdir', this.userDataDir,
      '--strategy-path', this.strategyPath,
      '--strategy', 'FreqAIWindowStrategy',
      '--freqaimodel', 'LightGBMClassifier',
    ];
    let child;
    try {
      child = this.spawnImpl(this.python, args, {
        cwd: this.rootDir,
        env: {
          ...process.env,
          FREQAI_PREDICTION_FILE: this.predictionPath,
          FREQAI_INTRABAR_CANDLE_FILE: this.intrabarCandlePath,
          FREQAI_USER_DATA_DIR: this.userDataDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.handleWorkerExit(null, error);
      return;
    }
    this.child = child;
    this.startedAt = this.now();
    this.status = 'TRAINING';
    this.lastError = null;
    child.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        console.log(`[freqai] ${line}`);
      }
    });
    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        console.error(`[freqai] ${line}`);
      }
    });
    child.once('error', (error) => this.handleWorkerExit(child, error));
    child.once('exit', (code, signal) => {
      this.handleWorkerExit(child, new Error(
        `FreqAI worker exited (${signal || `code ${code}`}).`,
      ));
    });
  }

  handleWorkerExit(child, error) {
    if (child && this.child !== child) return;
    this.child = null;
    if (this.stopped) return;
    this.status = 'RESTARTING';
    this.lastError = error?.message || String(error || 'FreqAI worker exited.');
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.restartCount += 1;
      this.launch();
    }, this.restartMs);
    this.restartTimer.unref?.();
  }

  refreshPrediction() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.predictionPath, 'utf8'));
    } catch {
      if (this.child) this.status = 'TRAINING';
      else if (this.status !== 'STOPPED' && !['ERROR', 'RESTARTING'].includes(this.status)) {
        this.status = 'WAITING';
      }
      return;
    }
    const pUp = Number(raw.pUp);
    const pDown = Number(raw.pDown);
    const rawCandleStart = Number(raw.candleStart);
    const provisional = raw.provisional === true;
    const candleStart = provisional
      ? Math.floor(this.now() / 60_000) * 60_000
      : rawCandleStart;
    const candleCloseAt = provisional ? candleStart + 60_000 : Number(raw.candleCloseAt);
    const windowStart = Number(raw.windowStart);
    if (raw.doPredict !== true
      || !Number.isFinite(pUp) || !Number.isFinite(pDown)
      || pUp < 0 || pDown < 0 || pUp + pDown <= 0
      || !Number.isFinite(candleStart)
      || !Number.isFinite(candleCloseAt)
      || !Number.isFinite(windowStart)) {
      if (this.child) this.status = 'TRAINING';
      else if (this.status !== 'STOPPED' && !['ERROR', 'RESTARTING'].includes(this.status)) {
        this.status = 'WAITING';
      }
      return;
    }
    const total = pUp + pDown;
    this.lastPrediction = {
      source: 'FREQAI',
      pUp: pUp / total,
      pDown: pDown / total,
      side: pUp >= pDown ? 'UP' : 'DOWN',
      candleStart,
      candleCloseAt,
      windowStart,
      writtenAt: Number(raw.writtenAt) || this.now(),
      observedAt: Number(raw.observedAt) || Number(raw.writtenAt) || this.now(),
      provisional,
      model: String(raw.model || 'LightGBMClassifier'),
    };
    const ageMs = this.now() - this.lastPrediction.candleStart;
    const predictionAgeMs = this.now() - this.lastPrediction.observedAt;
    const maxPredictionAgeMs = this.lastPrediction.provisional ? 12_000 : 120_000;
    this.status = ageMs <= 120_000 && ageMs >= -5000
      && predictionAgeMs <= maxPredictionAgeMs && predictionAgeMs >= -5000
      ? 'READY'
      : 'STALE';
  }

  snapshot() {
    this.refreshPrediction();
    return {
      status: this.status,
      lastError: this.lastError,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      lastPrediction: this.lastPrediction ? { ...this.lastPrediction } : null,
      scoreCadence: 'FreqAI is polled every second; the strategy emits interim-candle scores on the five-second Freqtrade loop.',
      execution: 'Prediction process only; all Polymarket execution stays in the paper bot.',
    };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.restartTimer);
    this.pollTimer = null;
    this.restartTimer = null;
    if (this.child) {
      const child = this.child;
      this.child = null;
      try { child.kill('SIGTERM'); } catch {}
    }
    this.status = 'STOPPED';
  }
}

module.exports = FreqAIWorker;
