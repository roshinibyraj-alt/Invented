'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const FreqAIAuditStore = require('../freqai-audit-store');

test('saves and restores score audit records separately from the paper ledger', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freqai-audit-'));
  const store = new FreqAIAuditStore(path.join(directory, 'score-flip-audit.json'));
  const entries = [{ id: 'window:candle:score', pUp: 0.4, pDown: 0.6, checks: [] }];
  try {
    assert.deepEqual(store.load(), []);
    await store.save(entries);
    assert.deepEqual(store.load(), entries);
    assert.deepEqual(fs.readdirSync(directory), ['score-flip-audit.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses malformed saved audit data instead of silently clearing it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freqai-audit-invalid-'));
  const filePath = path.join(directory, 'score-flip-audit.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 9, entries: [] }));
    const store = new FreqAIAuditStore(filePath);
    assert.throws(() => store.load(), /unsupported format/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
