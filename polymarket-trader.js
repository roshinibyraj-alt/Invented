'use strict';

// ── Web Crypto API polyfill ──
if (!globalThis.crypto || typeof globalThis.crypto.subtle === 'undefined') {
  try {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false, configurable: true });
  } catch (_) {}
}

const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http } = require('viem');
const { polygon } = require('viem/chains');
const {
  ClobClient, AssetType, Side, OrderType
} = require('@polymarket/clob-client-v2');
const { RelayClient } = require('@polymarket/builder-relayer-client');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

const ORDER_POLL_MS      = 200;
const ORDER_POLL_TIMEOUT = 8000;

class PolymarketTrader {
  constructor(privateKey) {
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this._account = privateKeyToAccount(pk);
    this.address  = this._account.address;
    this._walletClient = createWalletClient({ account: this._account, chain: polygon, transport: http() });
    this._clob  = null;
    this.apiKey = null;
    this.balance = 0;
    this.depositWallet = null;
    this._log   = () => {};
    this._inflight = new Map(); // idempotency-key -> last result, for placeLimitBuy() only
  }

  setLogFn(fn) { this._log = fn; }

  async authenticate() {
    this._log('🔑 Authenticating...');
    // Derive deposit wallet from EOA
    try {
      const relayer = new RelayClient('https://relayer-v2.polymarket.com', CHAIN_ID, this._walletClient);
      this.depositWallet = await relayer.deriveDepositWalletAddress();
      this._log(`🏦 Deposit wallet: ${this.depositWallet}`);
    } catch (_) {
      this._log('⚠️ Could not derive deposit wallet, falling back to EOA');
    }
    const tempClient = new ClobClient({
      host: CLOB_HOST, chain: CHAIN_ID, signer: this._walletClient,
    });
    const creds = await tempClient.createOrDeriveApiKey();
    this.apiKey = creds.key;
    this._clob = new ClobClient({
      host: CLOB_HOST, chain: CHAIN_ID, signer: this._walletClient, creds,
      ...(this.depositWallet ? { signatureType: 3, funderAddress: this.depositWallet } : {}),
    });
    this._log(`✅ Auth OK: ${this.address}`);
    return { apiKey: this.apiKey };
  }

  async approveAllowance(amount = null) {
    try {
      await this._clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const ba = await this._clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const allowance = parseFloat(ba?.allowance ?? '0') / 1e6;
      const bal = parseFloat(ba?.balance ?? '0') / 1e6;
      this._log(`ℹ️  Allowance: $${allowance.toFixed(2)} | Balance: $${bal.toFixed(2)}`);
      if (allowance <= 0) this._log('⚠️  Allowance is $0 — run approveAllowance to approve pUSD');
      return allowance > 0;
    } catch (e) {
      this._log(`⚠️  Allowance check: ${e.message}`);
      return false;
    }
  }

  async getBalance() {
    try {
      const resp = await this._clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      if (resp?.error) return this.balance;
      this.balance = parseFloat(resp?.balance ?? '0') / 1e6;
      return this.balance;
    } catch (_) { return this.balance; }
  }

  // ── GTC limit order (entry) ──
  async placeGtcOrder(tokenId, side, price, size) {
    const sideVal = side === 'BUY' ? Side.BUY : Side.SELL;
    let tickSize = '0.01', negRisk = false;
    try { tickSize = (await this._clob.getTickSize(tokenId)) ?? '0.01'; } catch (_) {}
    try { negRisk  = (await this._clob.getNegRisk(tokenId))  ?? false;  } catch (_) {}
    const resp = await this._clob.createAndPostOrder(
      { tokenID: tokenId, price, size, side: sideVal },
      { tickSize, negRisk },
      OrderType.GTC
    );
    const id = resp?.orderID ?? resp?.id ?? null;
    if (!id) throw new Error(`No orderID: ${JSON.stringify(resp).substring(0,100)}`);
    this._log(`🔏 GTC ${side} ${size}sh@${price} id:${id}`);
    return { id };
  }

  // ── FOK market BUY — amount is dollars ──
  async placeFokBuy(tokenId, dollarAmount) {
    let tickSize = '0.01', negRisk = false;
    try { tickSize = (await this._clob.getTickSize(tokenId)) ?? '0.01'; } catch (_) {}
    try { negRisk  = (await this._clob.getNegRisk(tokenId))  ?? false;  } catch (_) {}
    const resp = await this._clob.createAndPostMarketOrder(
      { tokenID: tokenId, amount: dollarAmount, side: Side.BUY, orderType: OrderType.FOK },
      { tickSize, negRisk },
      OrderType.FOK
    );
    const id        = resp?.orderID ?? resp?.id ?? null;
    const status    = resp?.status || (id ? 'UNKNOWN' : 'FAILED');
    const remaining = parseFloat(resp?.remaining_size ?? '999');
    const isFilled  = status === 'FILLED' || (resp?.match_status || '').toLowerCase() === 'filled' || remaining === 0;
    const avgPrice  = parseFloat(resp?.avg_fill_price || resp?.price || '0');
    if (id) this._log(`🏁 FOK BUY $${dollarAmount} → ${status} avg:${avgPrice} id:${id.slice(0,12)}…`);
    return { id, status, isFilled, avgPrice, raw: resp };
  }

  // ── FOK market SELL — amount is number of shares ──
  async placeFokSell(tokenId, shares) {
    let tickSize = '0.01', negRisk = false;
    try { tickSize = (await this._clob.getTickSize(tokenId)) ?? '0.01'; } catch (_) {}
    try { negRisk  = (await this._clob.getNegRisk(tokenId))  ?? false;  } catch (_) {}
    const resp = await this._clob.createAndPostMarketOrder(
      { tokenID: tokenId, amount: shares, side: Side.SELL, orderType: OrderType.FOK },
      { tickSize, negRisk },
      OrderType.FOK
    );
    const id        = resp?.orderID ?? resp?.id ?? null;
    const status    = resp?.status || (id ? 'UNKNOWN' : 'FAILED');
    const remaining = parseFloat(resp?.remaining_size ?? '999');
    const isFilled  = status === 'FILLED' || (resp?.match_status || '').toLowerCase() === 'filled' || remaining === 0;
    const avgPrice  = parseFloat(resp?.avg_fill_price || resp?.price || '0');
    if (id) this._log(`🏁 FOK SELL ${shares}sh → ${status} avg:${avgPrice} id:${id.slice(0,12)}…`);
    return { id, status, isFilled, avgPrice, raw: resp };
  }

  // ── Kept for backward compatibility ──
  async placeFokOrder(tokenId, side, amount) {
    if (side === 'BUY') return this.placeFokBuy(tokenId, amount);
    return this.placeFokSell(tokenId, amount);
  }

  // ── Poll order until filled or timeout ──
  // Reads size_matched on EVERY poll, not just when status is fully FILLED —
  // a resting order sits at status LIVE while partially matching, and that
  // partial progress was previously invisible: a timeout used to report
  // "filled: false" with no size at all, discarding a real fill that had
  // already happened on the exchange. Now every return path (full fill,
  // cancelled, or timeout) carries the best-known filledSize.
  async waitForFill(orderId, timeoutMs = ORDER_POLL_TIMEOUT) {
    const deadline = Date.now() + timeoutMs;
    let last = { size: 0, filledSize: 0, order: null };
    while (Date.now() < deadline) {
      try {
        const order = await this._clob.getOrder(orderId);
        if (order) {
          const rawSize = order.original_size ?? order.size ?? '0';
          const rawFilled = order.size_matched ?? order.filled_size ?? order.taker_amount ?? '0';
          last = { size: parseFloat(rawSize), filledSize: parseFloat(rawFilled), order };
          const status = order.status || '';
          const matchStatus = (order.match_status || order.matchStatus || '').toLowerCase();
          const state = (order.state || '').toLowerCase();
          const fullyFilled = status === 'FILLED' || matchStatus === 'filled' || state === 'filled'
            || (last.size > 0 && last.filledSize >= last.size);
          if (fullyFilled) {
            this._log(`✅ ORDER FILLED ${orderId.slice(0,12)}… size:${last.size} filled:${last.filledSize}`);
            return { filled: true, size: last.size, filledSize: last.filledSize, order };
          }
          const cancelled = status === 'CANCELLED' || matchStatus === 'cancelled';
          if (cancelled) {
            // A cancelled order can still carry a real partial fill from
            // before the cancel took effect — report it, never discard it.
            if (last.filledSize > 0) this._log(`⚠️  ORDER CANCELLED WITH PARTIAL FILL ${orderId.slice(0,12)}… filled:${last.filledSize}/${last.size}`);
            return { filled: last.filledSize > 0, cancelled: true, size: last.size, filledSize: last.filledSize, order };
          }
        }
      } catch (_) {}
      await sleep(ORDER_POLL_MS);
    }
    this._log(`⏰ ORDER TIMEOUT ${orderId.slice(0,12)}… last known filled:${last.filledSize}/${last.size}`);
    return { filled: last.filledSize > 0, cancelled: false, timeout: true, size: last.size, filledSize: last.filledSize };
  }

  // ── Fetch order book ──
  async getOrderBook(tokenId) {
    try { return await this._clob.getOrderBook(tokenId); }
    catch (_) { return null; }
  }

  // ── Get best bid/ask from order book ──
  async getBestBidAsk(tokenId) {
    try {
      const book = await this._clob.getOrderBook(tokenId);
      if (!book) return null;
      const bids = book.bids || [];
      const asks = book.asks || [];
      const bestBid = bids.length > 0 ? parseFloat(bids[0]?.price || '0') : null;
      const bestAsk = asks.length > 0 ? parseFloat(asks[0]?.price || '0') : null;
      return { bestBid, bestAsk };
    } catch (_) { return null; }
  }


  // ── FOK order with explicit price & size (no market price calc) ──
  async placeFokLimitOrder(tokenId, side, price, size) {
    const sideVal = side === 'BUY' ? Side.BUY : Side.SELL;
    let tickSize = '0.01', negRisk = false;
    try { tickSize = (await this._clob.getTickSize(tokenId)) ?? '0.01'; } catch (_) {}
    try { negRisk  = (await this._clob.getNegRisk(tokenId))  ?? false;  } catch (_) {}
    const resp = await this._clob.createAndPostOrder(
      { tokenID: tokenId, price, size, side: sideVal },
      { tickSize, negRisk },
      OrderType.FOK
    );
    const id = resp?.orderID ?? resp?.id ?? null;
    const status = resp?.status || (id ? 'UNKNOWN' : 'FAILED');
    const matchStatus = (resp?.match_status || '').toLowerCase();
    const isFilled = status === 'FILLED' || matchStatus === 'filled' || (size > 0 && parseFloat(resp?.remaining_size || '999') === 0);
    const avgPrice = parseFloat(resp?.avg_fill_price || resp?.price || price);
    if (id) this._log(`🏁 FOK ${side} ${size}sh@${price} → ${status} avg:${avgPrice} id:${id.slice(0,12)}`);
    return { id, status, isFilled, avgPrice, raw: resp };
  }

  async getOpenOrders() { return this._clob.getOpenOrders(); }
  async cancelOrder(orderId) { return this._clob.cancelOrder(orderId); }
  async getOrder(orderId) { return this._clob.getOrder(orderId); }
  defaultHeaders() { return { 'Content-Type': 'application/json' }; }
  l2Headers()      { return {}; }

  // ─────────────────────────────────────────────────────────────
  // NEW — additive only, nothing above this line was changed.
  //
  // placeLimitBuy() is what cricket-bot.js (the hedge bot) calls for its
  // LIVE combined entries. It didn't exist on this trader before, so LIVE
  // orders from that bot were silently skipped. It's a thin wrapper around
  // your existing placeFokLimitOrder — same underlying call, same behavior
  // for a clean success/rejection — with two things added ONLY for the
  // ambiguous-failure case (network drop / timeout, not a normal rejection):
  //
  //   1. reconcileToken() checks live order state before reporting failure,
  //      instead of leaving the caller to guess and blindly resubmit —
  //      this is the fix for "retried and drained capital" from a couple
  //      messages ago (Polymarket's own docs confirm a dropped connection
  //      does not stop an order that's already past validation from
  //      finishing server-side, so a thrown exception here does NOT mean
  //      the order didn't happen).
  //   2. An optional idempotencyKey — if the SAME key is passed twice
  //      (e.g. by future retry logic reusing "btc-1784861100-primary-up"),
  //      the second call reuses the first call's result instead of firing
  //      a second real order. Nothing calls this today; it's there so any
  //      retry logic added later is safe by construction rather than by
  //      discipline.
  // ─────────────────────────────────────────────────────────────
  async placeLimitBuy(tokenId, price, size, opts = {}) {
    const key = opts.idempotencyKey || null;
    if (key && this._inflight.has(key)) {
      this._log(`⏳ placeLimitBuy: reusing result for idempotency key "${key}" instead of resubmitting`);
      return this._inflight.get(key);
    }
    let result;
    try {
      const resp = await this.placeFokLimitOrder(tokenId, 'BUY', price, size);
      result = {
        id: resp.id,
        filled: !!resp.isFilled,
        avgPrice: resp.avgPrice || price,
        filledShares: resp.isFilled ? size : 0,
        raw: resp.raw,
      };
    } catch (e) {
      this._log(`⚠️  placeLimitBuy threw (${e.message}) — reconciling live order state before reporting failure`);
      const reconciled = await this.reconcileToken(tokenId, size);
      result = reconciled
        ? { id: reconciled.orderId || null, filled: true, avgPrice: reconciled.avgPrice || price, filledShares: reconciled.filledShares, raw: null, reconciled: true }
        : { id: null, filled: false, avgPrice: price, filledShares: 0, raw: null, error: e.message };
    }
    if (key) this._inflight.set(key, result);
    return result;
  }

  // Checks whether shares for this token already matched on your open orders
  // before you (or a retry) submit anything new. Returns null if nothing
  // matched yet (safe to place a fresh order for the full size); returns the
  // matched amount if something already landed (only order the shortfall,
  // if anything, don't repeat the full size).
  async reconcileToken(tokenId) {
    try {
      const openOrders = await this.getOpenOrders();
      const forToken = (openOrders || []).filter(o => String(o.asset_id || o.tokenID || o.token_id) === String(tokenId));
      const matched = forToken.reduce((sum, o) => sum + parseFloat(o.size_matched ?? o.filled_size ?? '0'), 0);
      if (matched > 0) {
        const avg = forToken[0]?.price ? parseFloat(forToken[0].price) : null;
        this._log(`🔎 reconcileToken: ${matched}sh already matched for ${String(tokenId).slice(0, 10)}… before retrying`);
        return { filledShares: matched, avgPrice: avg, orderId: forToken[0]?.id || forToken[0]?.orderID || null };
      }
    } catch (e) {
      this._log(`⚠️  reconcileToken check failed: ${e.message}`);
    }
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = PolymarketTrader;
