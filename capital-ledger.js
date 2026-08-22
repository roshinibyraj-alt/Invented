'use strict';

const fs = require('fs');

function round2(value) { return Math.round((Number(value) || 0) * 100) / 100; }

function createCapitalLedger({ path, legacyPath, startingCapital = 4000 }) {
  function load() {
    try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (_) {}
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      if (Number.isFinite(legacy.bankroll)) {
        return {
          bankroll: round2(legacy.bankroll),
          realizedPnl: round2(legacy.realizedPnl || 0),
          totalFeesPaid: round2(legacy.totalFeesPaid || 0),
        };
      }
    } catch (_) {}
    return {
      bankroll: round2(startingCapital),
      realizedPnl: 0,
      totalFeesPaid: 0,
    };
  }

  const state = Object.assign({
    bankroll: round2(startingCapital),
    realizedPnl: 0,
    totalFeesPaid: 0,
  }, load());

  function save() {
    try {
      fs.writeFileSync(path, JSON.stringify({ ...state, savedAt: Date.now() }));
    } catch (_) {}
  }

  function adjust(cashDelta, feeDelta = 0) {
    state.bankroll = round2(state.bankroll + cashDelta);
    state.totalFeesPaid = round2(state.totalFeesPaid + feeDelta);
    save();
  }

  return {
    startingCapital: round2(startingCapital),
    available: () => state.bankroll,
    realizedPnl: () => state.realizedPnl,
    totalFeesPaid: () => state.totalFeesPaid,
    charge: amount => adjust(-Math.max(0, amount)),
    credit: amount => adjust(Math.max(0, amount)),
    addFee: amount => adjust(0, Math.max(0, amount)),
    recordResult: pnl => { state.realizedPnl = round2(state.realizedPnl + pnl); save(); },
    adjust,
    snapshot: () => ({ ...state }),
    save,
  };
}

module.exports = { createCapitalLedger };
