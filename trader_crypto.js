'use strict';

const { webcrypto } = require('node:crypto');

function ensureWebCrypto(scope = globalThis) {
  if (scope.crypto?.subtle) return;
  if (!webcrypto?.subtle) {
    throw new Error('Web Crypto is required for Polymarket authenticated requests');
  }
  scope.crypto = webcrypto;
}

module.exports = { ensureWebCrypto };