'use strict';

// ── Web Crypto API polyfill ──
if (!globalThis.crypto || typeof globalThis.crypto.subtle === 'undefined') {
  try {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false, configurable: true });
  } catch (_) {}
}

const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http, encodeFunctionData, prepareEncodeFunctionData, maxUint256 } = require('viem');
const { polygon } = require('viem/chains');
const {
  ClobClient, SignatureTypeV2, AssetType, Side, OrderType
} = require('@polymarket/clob-client-v2');
const { RelayClient } = require('@polymarket/builder-relayer-client');

const CLOB_HOST = 'https://clob.polymarket.com';
const RELAYER_HOST = process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com';
const CHAIN_ID = 137;

const ORDER_POLL_MS      = 200;
const ORDER_POLL_TIMEOUT = 8000;

const PUSD_TOKEN = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B';

const ERC20_APPROVE_ABI = [{
  name: 'approve', type: 'function',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}];

class PolymarketTrader {
  constructor(privateKey, funderAddr) {
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this._account = privateKeyToAccount(pk);
    this.address  = this._account.address;
    this._walletClient = createWalletClient({ account: this._account, chain: polygon, transport: http() });
    this.depositWallet = funderAddr;
    this._clob  = null;
    this.apiKey = null;
    this.balance = 0;
    this._log   = () => {};
    this._relayClient = null;
  }

  setLogFn(fn) { this._log = fn; }

  async authenticate() {
    this._log('🔑 Authenticating...');
    const tempClient = new ClobClient({
      host: CLOB_HOST, chain: CHAIN_ID, signer: this._walletClient,
      signatureType: SignatureTypeV2.POLY_1271, funderAddress: this.depositWallet
    });
    const creds = await tempClient.createOrDeriveApiKey();
    this.apiKey = creds.key;
    this._clob = new ClobClient({
      host: CLOB_HOST, chain: CHAIN_ID, signer: this._walletClient, creds,
      signatureType: SignatureTypeV2.POLY_1271, funderAddress: this.depositWallet
    });
    this._log(`✅ Auth OK: ${this.address}`);
    this._log(`💼 Deposit: ${this.depositWallet}`);
    return { apiKey: this.apiKey };
  }

  async approveAllowance(amount = null) {
    try {
      await this._clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const ba = await this._clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      let allowance = parseFloat(ba?.allowance ?? '0') / 1e6;
      this._log(`ℹ️  Allowance: $${allowance.toFixed(2)}`);

      if (allowance <= 0) {
        this._log('🔏 Approving pUSD via deposit wallet relay...');
        if (!this.depositWallet) throw new Error('FUNDER_ADDRESS (deposit wallet) required for approval');

        if (!this._relayClient) {
          this._relayClient = new RelayClient(RELAYER_HOST, CHAIN_ID, this._walletClient);
        }

        const erc20 = prepareEncodeFunctionData({
          abi: ERC20_APPROVE_ABI,
          functionName: 'approve',
        });
        const calldata = encodeFunctionData({
          ...erc20,
          args: [EXCHANGE_V2, maxUint256],
        });
        const approveCall = {
          target: PUSD_TOKEN,
          value: '0',
          data: calldata,
        };

        // Deploy deposit wallet if not yet deployed
        const deployed = await this._relayClient.getDeployed(this.depositWallet, 'WALLET');
        if (!deployed) {
          this._log('⏳ Deploying deposit wallet...');
          const deployResp = await this._relayClient.deployDepositWallet();
          const deployResult = await deployResp.wait();
          this._log(deployResult ? '✅ Deposit wallet deployed' : '⚠️ Deploy pending');
        }

        const deadline = Math.floor(Date.now() / 1000 + 240).toString();
        this._log('📤 Submitting deposit wallet batch approval...');
        const resp = await this._relayClient.executeDepositWalletBatch(
          [approveCall], this.depositWallet, deadline
        );
        const result = await resp.wait();

        if (result) {
          this._log(`✅ Relay approval tx: ${result.transactionHash || 'submitted'}`);
        } else {
          this._log('⚠️ Relay approval pending (check Polymarket for confirmation)');
        }

        await new Promise(r => setTimeout(r, 5000));
        await this._clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const ba2 = await this._clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        allowance = parseFloat(ba2?.allowance ?? '0') / 1e6;
        this._log(`✅ Allowance after approval: $${allowance.toFixed(2)}`);
      } else {
        this._log('✅ Allowance OK');
      }
      return allowance > 0;
    } catch (e) {
      this._log(`⚠️ Allowance: ${e.message}`);
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
      { tokenID: tokenId, price: String(price), size: String(size), side: sideVal },
      { tickSize, negRisk },
      OrderType.GTC
    );
    const id = resp?.orderID ?? resp?.id ?? null;
    if (!id) throw new Error(`No orderID: ${JSON.stringify(resp).substring(0,100)}`);
    this._log(`🔏 GTC ${side} ${size}sh@${price} id:${id}`);
    return { id };
  }

  // ── FOK market order (exit/entry) ──
  async placeFokOrder(tokenId, side, amount) {
    const sideVal = side === 'BUY' ? Side.BUY : Side.SELL;
    let tickSize = '0.01', negRisk = false;
    try { tickSize = (await this._clob.getTickSize(tokenId)) ?? '0.01'; } catch (_) {}
    try { negRisk  = (await this._clob.getNegRisk(tokenId))  ?? false;  } catch (_) {}
    const resp = await this._clob.createAndPostMarketOrder(
      { tokenID: tokenId, amount, side: sideVal, orderType: OrderType.FOK },
      { tickSize, negRisk },
      OrderType.FOK
    );
    const id = resp?.orderID ?? resp?.id ?? null;
    const status = resp?.status || (id ? 'UNKNOWN' : 'FAILED');
    const isFilled = status === 'FILLED' || resp?.match_status === 'filled' || (resp?.remaining_size && parseFloat(resp.remaining_size) === 0);
    const avgPrice = parseFloat(resp?.avg_fill_price || resp?.price || '0');
    if (id) this._log(`🏁 FOK ${side} $${amount} → ${status} avg:${avgPrice} id:${id ? id.slice(0,12) : '?'}…`);
    return { id, status, isFilled, avgPrice, raw: resp };
  }

  // ── Poll order until filled or timeout ──
  async waitForFill(orderId, timeoutMs = ORDER_POLL_TIMEOUT) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const order = await this._clob.getOrder(orderId);
        if (!order) { await sleep(ORDER_POLL_MS); continue; }
        const status = order.status || '';
        const matchStatus = (order.match_status || order.matchStatus || '').toLowerCase();
        const state = (order.state || '').toLowerCase();
        const filled = status === 'FILLED' || matchStatus === 'filled' || state === 'filled';
        if (filled) {
          const rawSize = order.original_size ?? order.size ?? '0';
          const rawFilled = order.size_matched ?? order.filled_size ?? order.taker_amount ?? '0';
          const size = parseFloat(rawSize);
          const filledSize = parseFloat(rawFilled);
          this._log(`✅ ORDER FILLED ${orderId.slice(0,12)}… size:${size} filled:${filledSize}`);
          return { filled: true, size, filledSize, order };
        }
        const cancelled = status === 'CANCELLED' || matchStatus === 'cancelled';
        if (cancelled) return { filled: false, cancelled: true };
      } catch (_) {}
      await sleep(ORDER_POLL_MS);
    }
    this._log(`⏰ ORDER TIMEOUT ${orderId.slice(0,12)}…`);
    return { filled: false, cancelled: false, timeout: true };
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
      { tokenID: tokenId, price: String(price), size: String(size), side: sideVal },
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
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = PolymarketTrader;
