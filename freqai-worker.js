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
    this.rawPrediction = null;
    this.lastClosedPrediction = null;
    this.provisionalReference = null;
    this.scoreAdjustment = { ready: false, reason: 'Waiting for a closed one-minute baseline.' };
    this.closedPredictionHistory = [];
    this.scoreHistory = [];
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

  normalizePrediction(raw, now, provisional = raw?.provisional === true) {
    if (!raw || raw.doPredict !== true) return null;
    const rawUp = Number(raw.pUp), rawDown = Number(raw.pDown);
    const rawStart = Number(raw.candleStart);
    const windowStart = Number(raw.windowStart);
    if (!Number.isFinite(rawUp) || !Number.isFinite(rawDown)
      || rawUp < 0 || rawDown < 0 || rawUp + rawDown <= 0
      || !Number.isFinite(rawStart) || !Number.isFinite(windowStart)) return null;
    const candleStart = provisional
      ? Math.floor(now / 60_000) * 60_000
      : Math.floor(rawStart / 60_000) * 60_000;
    if (provisional && Math.floor(rawStart / 60_000) * 60_000 !== candleStart) return null;
    const total = rawUp + rawDown;
    return {
      source: 'FREQAI',
      pUp: rawUp / total,
      pDown: rawDown / total,
      candleStart,
      candleCloseAt: candleStart + 60_000,
      windowStart,
      writtenAt: Number(raw.writtenAt) || now,
      observedAt: Number(raw.observedAt) || Number(raw.writtenAt) || now,
      provisional,
      model: String(raw.model || 'LightGBMClassifier'),
    };
  }

  rememberClosedPrediction(prediction) {
    if (!prediction || prediction.candleCloseAt > this.now() + 1000) return;
    if (this.lastClosedPrediction
      && prediction.candleCloseAt < this.lastClosedPrediction.candleCloseAt) return;
    if (!this.lastClosedPrediction
      || prediction.candleCloseAt > this.lastClosedPrediction.candleCloseAt) {
      this.closedPredictionHistory.push({
        candleStart: prediction.candleStart,
        candleCloseAt: prediction.candleCloseAt,
        windowStart: prediction.windowStart,
        pUp: prediction.pUp,
        pDown: prediction.pDown,
        observedAt: prediction.observedAt,
      });
      this.closedPredictionHistory = this.closedPredictionHistory.slice(-20);
    }
    this.lastClosedPrediction = { ...prediction, provisional: false };
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
    const provisional = raw.provisional === true;
    const now = this.now();
    const closedRaw = raw.closedPrediction
      || (!provisional ? raw : null);
    const closedPrediction = this.normalizePrediction(closedRaw, now, false);
    if (closedPrediction) this.rememberClosedPrediction(closedPrediction);

    const current = this.normalizePrediction(raw, now, provisional);
    if (!current) {
      this.rawPrediction = null;
      this.lastPrediction = null;
      this.scoreAdjustment = {
        ready: false, reason: 'The latest FreqAI output is not a valid prediction.',
      };
      if (this.child) this.status = 'TRAINING';
      else if (this.status !== 'STOPPED' && !['ERROR', 'RESTARTING'].includes(this.status)) {
        this.status = 'WAITING';
      }
      return;
    }
    this.rawPrediction = current;

    if (!provisional) {
      this.rememberClosedPrediction(current);
      this.lastPrediction = {
        ...current, side: current.pUp >= current.pDown ? 'UP' : 'DOWN',
        rawPUp: current.pUp, rawPDown: current.pDown,
        baselinePUp: current.pUp, baselinePDown: current.pDown,
        adjustmentDelta: 0, adjustmentReady: true, scoreMode: 'CLOSED_1M_BASELINE',
      };
      this.scoreAdjustment = {
        ready: true, mode: 'CLOSED_1M_BASELINE',
        closedCandleStart: current.candleStart,
        baselinePUp: current.pUp, baselinePDown: current.pDown,
        rawPUp: current.pUp, rawPDown: current.pDown,
        deltaPUp: 0, adjustedPUp: current.pUp, adjustedPDown: current.pDown,
        observedAt: current.observedAt,
      };
    } else {
      if (!this.provisionalReference
        || this.provisionalReference.candleStart !== current.candleStart) {
        this.provisionalReference = {
          candleStart: current.candleStart,
          pUp: current.pUp,
          pDown: current.pDown,
          observedAt: current.observedAt,
        };
      }
      const baseline = this.lastClosedPrediction;
      const hasAdjacentBaseline = baseline
        && baseline.windowStart === current.windowStart
        && baseline.candleCloseAt === current.candleStart;
      if (!hasAdjacentBaseline) {
        this.lastPrediction = null;
        this.scoreAdjustment = {
          ready: false, mode: 'WAITING_FOR_CLOSED_1M_BASELINE',
          reason: 'Waiting for the immediately preceding closed one-minute score in this five-minute window.',
          rawPUp: current.pUp, rawPDown: current.pDown,
          candleStart: current.candleStart, observedAt: current.observedAt,
        };
      } else {
        const deltaPUp = current.pUp - this.provisionalReference.pUp;
        const adjustedPUp = Math.max(0, Math.min(1, baseline.pUp + deltaPUp));
        const adjustedPDown = 1 - adjustedPUp;
        this.lastPrediction = {
          ...current, pUp: adjustedPUp, pDown: adjustedPDown,
          side: adjustedPUp >= adjustedPDown ? 'UP' : 'DOWN',
          rawPUp: current.pUp, rawPDown: current.pDown,
          baselinePUp: baseline.pUp, baselinePDown: baseline.pDown,
          referencePUp: this.provisionalReference.pUp,
          referencePDown: this.provisionalReference.pDown,
          adjustmentDelta: deltaPUp, adjustmentReady: true,
          scoreMode: 'CLOSED_BASELINE_PLUS_INTRAMINUTE_DELTA',
        };
        this.scoreAdjustment = {
          ready: true, mode: 'CLOSED_BASELINE_PLUS_INTRAMINUTE_DELTA',
          closedCandleStart: baseline.candleStart,
          baselinePUp: baseline.pUp, baselinePDown: baseline.pDown,
          referencePUp: this.provisionalReference.pUp,
          referencePDown: this.provisionalReference.pDown,
          rawPUp: current.pUp, rawPDown: current.pDown,
          deltaPUp, adjustedPUp, adjustedPDown,
          observedAt: current.observedAt, candleStart: current.candleStart,
        };
        if (!this.scoreHistory.length
          || this.scoreHistory[this.scoreHistory.length - 1].observedAt !== current.observedAt) {
          this.scoreHistory.push({ ...this.scoreAdjustment });
          this.scoreHistory = this.scoreHistory.slice(-60);
        }
      }
    }

    const ageMs = now - current.candleStart;
    const predictionAgeMs = now - current.observedAt;
    const maxPredictionAgeMs = provisional ? 12_000 : 120_000;
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
      rawPrediction: this.rawPrediction ? { ...this.rawPrediction } : null,
      lastClosedPrediction: this.lastClosedPrediction ? { ...this.lastClosedPrediction } : null,
      closedPredictionHistory: this.closedPredictionHistory.map(item => ({ ...item })),
      scoreAdjustment: { ...this.scoreAdjustment },
      scoreHistory: this.scoreHistory.map(item => ({ ...item })),
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
