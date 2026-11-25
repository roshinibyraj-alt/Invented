'use strict';

const fs = require('node:fs');
const path = require('node:path');

class FreqAIAuditStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('A FreqAI audit file path is required.');
    }
    this.filePath = path.resolve(filePath);
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (saved?.schemaVersion !== 1 || !Array.isArray(saved.entries)) {
        throw new Error('Saved FreqAI score audit has an unsupported format.');
      }
      return saved.entries;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`Could not read saved FreqAI score audit: ${error.message}`);
    }
  }

  async save(entries) {
    const directory = path.dirname(this.filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const saved = { schemaVersion: 1, savedAt: Date.now(), entries };
    await fs.promises.writeFile(temporaryPath, JSON.stringify(saved), { mode: 0o600 });
    await fs.promises.rename(temporaryPath, this.filePath);
  }
}

module.exports = FreqAIAuditStore;
