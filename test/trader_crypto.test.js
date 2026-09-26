'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureWebCrypto } = require('../trader_crypto');

test('provides Web Crypto when the runtime has no global crypto', () => {
  const scope = {};
  ensureWebCrypto(scope);
  assert.equal(typeof scope.crypto.subtle.sign, 'function');
});

test('keeps an existing Web Crypto implementation', () => {
  const crypto = { subtle: {} };
  const scope = { crypto };
  ensureWebCrypto(scope);
  assert.equal(scope.crypto, crypto);
});