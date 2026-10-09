'use strict';

const EPSILON = 1e-9;

function queueAheadAtLimit(book, limitPrice) {
  const limit = Number(limitPrice);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return (book && Array.isArray(book.bids) ? book.bids : [])
    .reduce((sum, level) => {
      const price = Number(level.price);
      const size = Number(level.size);
      return Number.isFinite(price) && price >= limit - EPSILON
        && Number.isFinite(size) && size > 0 ? sum + size : sum;
    }, 0);
}

module.exports = { queueAheadAtLimit };
