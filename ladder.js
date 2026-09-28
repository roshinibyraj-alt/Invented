'use strict';

/**
 * Sizing from the ordered list of settled outcomes ('WIN' | 'LOSS') of one ladder.
 * Void windows never enter this list, so they never move the stake.
 *
 *   loss -> stake doubles, up to maxLoss doublings (100 -> 200 -> 400); the next loss resets to base
 *   win  -> stake doubles, up to maxWin doublings  (100 -> 200);        the next win  resets to base
 *   a win clears the loss streak and a loss clears the win streak
 *
 * Replayed from the full history each time, so a provisional outcome that later
 * turns out different (real resolution) fixes the stake automatically.
 */
function nextStake(outcomes, base, maxLoss, maxWin) {
  let L = 0;
  let W = 0;
  for (const o of outcomes) {
    if (o === 'WIN') {
      L = 0;
      W += 1;
      if (W > maxWin) W = 0;
    } else {
      W = 0;
      L += 1;
      if (L > maxLoss) L = 0;
    }
  }
  return base * Math.pow(2, L > 0 ? L : W);
}

module.exports = { nextStake };
