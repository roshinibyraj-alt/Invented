'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const PaperLedgerStore = require('../paper-ledger-store');

test('paper ledger store saves atomically and reads its snapshot back', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-ledger-'));
  const filePath = path.join(directory, 'ledger.json');
  const store = new PaperLedgerStore(filePath);
  const ledger = { schemaVersion: 1, strategyId: 'test', snapshot: { positions: [], cash: 123 } };
  try {
    assert.equal(store.load(), null);
    await store.save(ledger);
    assert.deepEqual(store.load(), ledger);
    assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('paper ledger store decodes the one-time compressed history import', () => {
  const ledger = { strategy: { id: 'test' }, account: { cash: 3000 } };
  const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(ledger))).toString('base64');
  assert.deepEqual(PaperLedgerStore.decodeBootstrap(encoded), ledger);
  assert.equal(PaperLedgerStore.decodeBootstrap(''), null);
  assert.throws(() => PaperLedgerStore.decodeBootstrap('not-valid-gzip'), /one-time paper-history import is invalid/);
});
