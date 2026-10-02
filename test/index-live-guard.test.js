'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('LIVE_TRADING=true is refused before wallet authentication', () => {
  const entrypoint = path.join(__dirname, '..', 'index.js');
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, LIVE_TRADING: 'true' },
    encoding: 'utf8',
    timeout: 5000,
  });
  const output = (result.stdout || '') + (result.stderr || '');

  assert.equal(result.status, 1);
  assert.match(output, /demo-only; LIVE_TRADING=true is blocked before wallet authentication/i);
  assert.doesNotMatch(output, /Authenticating with Polymarket/);
  assert.doesNotMatch(output, /MODE: LIVE/);
});