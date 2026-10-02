'use strict';

if (!globalThis.crypto || typeof globalThis.crypto.subtle === 'undefined') {
  try {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false, configurable: true });
  } catch (_) {}
}

const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http } = require('viem');
const { polygon } = require('viem/chains');
const { ClobClient, AssetType, Side, OrderType } = require('@polymarket/clob-client-v2');
const { RelayClient } = require('@polymarket/builder-relayer-client');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

class PolymarketTrader {
  constructor(privateKey) {
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    this._account = privateKeyToAccount(pk);
    this.address = this._account.address;
    this._walletClient = createWalletClient({ account: this._account, chain: polygon, transport: http() });
    this._clob = null;
    this.apiKey = null;
    this.balance = 0;
    this.depositWallet = null;
    this._log = () => {};
    this._marketOptionsCache = new Map();
  }

  setLogFn(fn) { this._log = fn; }

  async authenticate() {
    this._log('Authenticating with Polymarket...');
    try {
      const relayer = new RelayClient('https://relayer-v2.polymarket.com', CHAIN_ID, this._walletClient);
      this.depositWallet = await relayer.deriveDepositWalletAddress();
      this._log('Deposit wallet: ' + this.depositWallet);
    } catch (_) {
      this._log('Could not derive deposit wallet; falling back to EOA');
    }
    const tempClient = new ClobClient({ host: CLOB_HOST, chain: CHAIN_ID, signer: this._walletClient });
    const creds = await tempClient.createOrDeriveApiKey();
    this.apiKey = creds.key;
    this._clob = new ClobClient({
      host: CLOB_HOST, chain: CHAIN_ID, signer: this._walletClient, creds,
      ...(this.depositWallet ? { signatureType: 3, funderAddress: this.depositWallet } : {}),
    });
    this._log('Authentication ready: ' + this.address);
    return { apiKey: this.apiKey };
  }

  async approveAllowance() {
    try {
      await this._clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const result = await this._clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const allowanceValues = Object.values(result && result.allowances || {}).map((value) => Number(value) || 0);
      const allowance = (allowanceValues.length ? Math.max(...allowanceValues) : Number(result && result.allowance) || 0) / 1e6;
      const balance = Number(result && result.balance || 0) / 1e6;
      this._log('Collateral balance $' + balance.toFixed(2) + ' | allowance $' + allowance.toFixed(2));
      if (allowance <= 0) this._log('Allowance is $0; live orders may be rejected until CLOB collateral approval is granted');
      return allowance > 0;
    } catch (error) {
      this._log('Allowance check failed: ' + error.message);
      return false;
    }
  }

  async getBalance() {
    try {
      const result = await this._clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      if (result && result.error) return this.balance;
      this.balance = Number(result && result.balance || 0) / 1e6;
      return this.balance;
    } catch (_) { return this.balance; }
  }

  async getTokenBalance(tokenId) {
    try {
      const result = await this._clob.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
      if (result && result.error) return null;
      return Number(result && result.balance || 0) / 1e6;
    } catch (_) { return null; }
  }

  async prepareMarket(tokenIds) {
    await Promise.all((Array.isArray(tokenIds) ? tokenIds : [tokenIds]).filter(Boolean).map((tokenId) => this._marketOptions(tokenId)));
  }

  async getOrderBook(tokenId) {
    try { return await this._clob.getOrderBook(tokenId); }
    catch (_) { return null; }
  }

  async getBestBidAsk(tokenId) {
    const book = await this.getOrderBook(tokenId);
    if (!book) return null;
    const bids = (book.bids || []).map((item) => Number(item.price)).filter((price) => price > 0);
    const asks = (book.asks || []).map((item) => Number(item.price)).filter((price) => price > 0);
    return { bestBid: bids.length ? Math.max(...bids) : null, bestAsk: asks.length ? Math.min(...asks) : null };
  }

  async _marketOptions(tokenId) {
    if (this._marketOptionsCache.has(tokenId)) return this._marketOptionsCache.get(tokenId);
    let tickSize = '0.01';
    let negRisk = false;
    try { tickSize = (await this._clob.getTickSize(tokenId)) || tickSize; } catch (_) {}
    try { negRisk = (await this._clob.getNegRisk(tokenId)) || false; } catch (_) {}
    const options = { tickSize, negRisk };
    this._marketOptionsCache.set(tokenId, options);
    return options;
  }

  async placeGtcOrder(tokenId, side, price, size) {
    const sideValue = String(side).toUpperCase() === 'BUY' ? Side.BUY : Side.SELL;
    const options = await this._marketOptions(tokenId);
    const response = await this._clob.createAndPostOrder(
      { tokenID: tokenId, price: Number(price), side: sideValue, size: Number(size) },
      options,
      OrderType.GTC,
      true,
    );
    if (response && response.success === false) throw new Error(response.errorMsg || response.error || 'GTC order rejected');
    const id = response && (response.orderID || response.id);
    if (!id) throw new Error('GTC post-only order returned no order ID: ' + JSON.stringify(response).slice(0, 160));
    this._log('POST-ONLY GTC ' + side + ' ' + size + ' shares @ $' + price + ' | ' + id);
    return { id, status: response.status || 'LIVE', raw: response };
  }

  // Polymarket market BUY amount is USDC; market SELL amount is shares.
  async placeFakMarketOrder(tokenId, side, amount, orderOptions = {}) {
    const buying = String(side).toUpperCase() === 'BUY';
    const sideValue = buying ? Side.BUY : Side.SELL;
    const marketOptions = await this._marketOptions(tokenId);
    const requestedPrice = Number(orderOptions && orderOptions.priceLimit);
    const hasPriceLimit = Number.isFinite(requestedPrice) && requestedPrice > 0;
    const price = hasPriceLimit ? roundMarketPriceDown(requestedPrice, marketOptions.tickSize) : undefined;
    const targetShares = Number(orderOptions && orderOptions.targetShares);
    const marketAmount = buying && hasPriceLimit && Number.isFinite(targetShares) && targetShares > 0
      ? targetShares * price
      : Number(amount);
    const response = await this._clob.createAndPostMarketOrder(
      {
        tokenID: tokenId, amount: marketAmount, side: sideValue, orderType: OrderType.FAK,
        ...(hasPriceLimit ? { price } : {}),
      },
      marketOptions,
      OrderType.FAK,
    );
    if (response && response.success === false) throw new Error(response.errorMsg || response.error || 'FAK market order rejected');
    const id = response && (response.orderID || response.id);
    const raw = response || {};
    const making = Number(raw.makingAmount) || 0;
    const taking = Number(raw.takingAmount) || 0;
    const isFilled = making > 0 && taking > 0;
    const averagePrice = String(side).toUpperCase() === 'BUY' ? (taking > 0 ? making / taking : 0) : (making > 0 ? taking / making : 0);
    const status = raw.status || (isFilled ? 'matched' : 'unmatched');
    this._log('FAK MARKET ' + side + ' amount ' + amount + ' → ' + status + (id ? ' | ' + id : ''));
    return { id, status, isFilled, avgPrice: averagePrice, raw };
  }

  async getOrder(id) { return this._clob.getOrder(id); }
  async getOpenOrders() { return this._clob.getOpenOrders(); }
  async cancelOrder(id) { return this._clob.cancelOrder(id); }
  async cancelMarketOrders(tokenId) { return this._clob.cancelMarketOrders({ asset_id: tokenId }); }
}

function roundMarketPriceDown(price, tickSize) {
  const priceDecimals = {
    '0.1': 1, '0.01': 2, '0.005': 3, '0.0025': 4, '0.001': 3, '0.0001': 4,
  };
  const decimals = priceDecimals[String(tickSize)] ?? 2;
  const scale = 10 ** decimals;
  return Math.floor(Number(price) * scale) / scale;
}

module.exports = PolymarketTrader;
