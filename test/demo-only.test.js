'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('runtime entrypoint loads only the demo bot and demo trader', () => {
  const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(source, /require\('\.\/bot'\)/);
  assert.match(source, /require\('\.\/demo-trader'\)/);
  assert.doesNotMatch(source, /polymarket-trader|clob-client|builder-relayer|ccxt/i);
});

test('wallet, spot-feed, and legacy-strategy modules are removed', () => {
  for (const file of [
    'polymarket-trader.js',
    'ccxt-feed.js',
    'directional-bot.js',
    'directional-strategy.js',
    'paired-limit-bot.js',
    'strategy.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file + ' should be removed');
  }
});

test('package keeps only the public CLOB websocket dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.dependencies, { ws: '^8.18.0' });
});
