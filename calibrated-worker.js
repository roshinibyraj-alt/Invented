'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');

class CalibratedWorker {
  constructor({ directory, now = Date.now } = {}) {
    this.directory = directory;
    this.now = now;
    this.models = Object.fromEntries(['5m', '15m'].map(t => [t, { status: 'WAITING', metrics: null, prediction: null }]));
    this.status = 'WAITING';
    this.message = 'Starting separate calibrated models.';
    this.child = null;
    this.stopped = true;
  }
  consume(row) {
    if (row.type === 'status') {
      this.status = row.status; this.message = row.message;
      if (row.status === 'ERROR' || row.status === 'TRAINING') {
        for (const model of Object.values(this.models)) model.prediction = null;
      }
    }
    const model = this.models[row.timeframe];
    if (!model) return;
    if (row.type === 'model') {
      model.metrics = row.metrics;
      model.status = row.metrics?.accepted ? 'READY' : 'VALIDATION_REJECTED';
    }
    if (row.type === 'prediction') {
      model.prediction = row.prediction;
      this.status = 'RUNNING';
      this.message = 'Completed-minute predictions; refresh after each one-minute close.';
    }
  }
  start() {
    this.stopped = false;
    this.launch();
  }
  launch() {
    if (this.stopped) return;
    this.status = 'STARTING';
    this.child = spawn(process.env.PYTHON_BIN || 'python3', ['-u', 'calibrated_model.py'], {
      cwd: __dirname, env: { ...process.env, MODEL_DATA_DIR: this.directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try { this.consume(JSON.parse(line)); }
      catch { console.log('[model]', line.slice(0, 400)); }
    });
    this.child.stderr.on('data', chunk => console.error('[model]', String(chunk).slice(0, 2000)));
    this.child.once('error', error => {
      this.status = 'ERROR'; this.message = error.message;
    });
    this.child.once('exit', () => {
      this.child = null;
      for (const model of Object.values(this.models)) model.prediction = null;
      if (!this.stopped) {
        this.status = 'RESTARTING';
        this.timer = setTimeout(() => this.launch(), 15000);
      }
    });
  }
  prediction(timeframe, start) {
    const model = this.models[timeframe], p = model?.prediction, now = this.now();
    if (this.status !== 'RUNNING' || model?.status !== 'READY' || !p?.accepted
      || p.windowStart !== start || !Number.isFinite(p.pUp) || p.pUp < 0 || p.pUp > 1
      || !Number.isFinite(p.pDown) || Math.abs(p.pUp + p.pDown - 1) > .00001
      || !Number.isFinite(p.observedAt) || p.observedAt > now || now >= p.validUntil
      || now - p.writtenAt > 70000 || now - model.metrics.trainedAt > 8 * 3600000) return null;
    return p;
  }
  snapshot() { return { status: this.status, message: this.message, models: this.models }; }
  stop() {
    this.stopped = true; clearTimeout(this.timer);
    this.child?.kill('SIGTERM');
  }
}
module.exports = CalibratedWorker;
