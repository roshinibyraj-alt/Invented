'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

class PaperLedgerStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('A paper-ledger file path is required.');
    }
    this.filePath = path.resolve(filePath);
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Could not read saved paper history: ${error.message}`);
    }
  }

  async save(ledger) {
    const directory = path.dirname(this.filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify(ledger), { mode: 0o600 });
    await fs.promises.rename(temporaryPath, this.filePath);
  }

  async archive(ledger) {
    const name = String(ledger.strategyId || ledger.snapshot?.strategy?.id || 'previous').replace(/[^a-z0-9_-]/gi, '_');
    const archivePath = `${this.filePath}.archive-${name}-${Date.now()}.json`;
    await fs.promises.writeFile(archivePath, JSON.stringify(ledger), { mode: 0o600, flag: 'wx' });
    return archivePath;
  }

  static decodeBootstrap(encoded) {
    if (!encoded) return null;
    try {
      const compressed = Buffer.from(encoded, 'base64');
      return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    } catch (error) {
      throw new Error(`The one-time paper-history import is invalid: ${error.message}`);
    }
  }
}

module.exports = PaperLedgerStore;
