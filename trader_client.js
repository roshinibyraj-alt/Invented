'use strict';

const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http } = require('viem');
const { polygon } = require('viem/chains');
const {
  ClobClient,
  AssetType,
  Side,
  OrderType,
} = require('@polymarket/clob-client-v2');
const { RelayClient } = require('@polymarket/builder-relayer-client');
const { parseMarketResponse } = require('./order_utils');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

class PolymarketTrader {
  constructor(privateKey, log = () => {}) {
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this.account = privateKeyToAccount(pk);
    this.wallet = createWalletClient({
      account: this.account,
      chain: polygon,
      transport: http(),
    });
    this.clob = null;
    this.log = log;
    this.depositWallet = null;
  }

  async authenticate() {
    try {
      const relayer = new RelayClient(
        'https://relayer-v2.polymarket.com',
        CHAIN_ID,
        this.wallet,
      );
      this.depositWallet = await relayer.deriveDepositWalletAddress();
    } catch (error) {
      this.log(`deposit wallet derivation unavailable: ${error.message}`);
    }

    const temporary = new ClobClient({
      host: CLOB_HOST,
      chain: CHAIN_ID,
      signer: this.wallet,
    });
    const creds = await temporary.createOrDeriveApiKey();
    this.clob = new ClobClient({
      host: CLOB_HOST,
      chain: CHAIN_ID,
      signer: this.wallet,
      creds,
      ...(this.depositWallet
        ? { signatureType: 3, funderAddress: this.depositWallet }
        : {}),
    });
    return this.account.address;
  }

  async balance() {
    const result = await this.clob.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    return parseFloat(result?.balance || '0') / 1e6;
  }

  async book(tokenId) {
    const result = await this.clob.getOrderBook(tokenId);
    const bids = result?.bids || [];
    const asks = result?.asks || [];
    const bidValues = bids.map((x) => parseFloat(x.price)).filter(Number.isFinite);
    const askValues = asks.map((x) => parseFloat(x.price)).filter(Number.isFinite);
    return {
      bestBid: bidValues.length ? Math.max(...bidValues) : null,
      bestAsk: askValues.length ? Math.min(...askValues) : null,
    };
  }

  async verifyBuy(tokenId, openTs, orderId) {
    // Only authenticated account trades are returned by this endpoint.
    // Never interpret an empty response as permission to retry a buy.
    const trades = await this.clob.getTrades({ asset_id: tokenId });
    if (!Array.isArray(trades)) {
      throw new Error('Unexpected exchange trade history response');
    }
    const matches = trades.filter((trade) => {
      const id = trade.taker_order_id || trade.taker_order_id_hash || trade.id;
      const timestamp = Number(trade.match_time || trade.created_at || 0);
      return (trade.asset_id === tokenId || trade.asset_id === String(tokenId))
        && String(trade.side).toUpperCase() === 'BUY'
        && (orderId ? id === orderId : timestamp >= Number(openTs));
    });
    return { matchingTrades: matches.length, orderId: orderId || null };
  }

  async buy(tokenId, price, amount) {
    const tickSize = (await this.clob.getTickSize(tokenId)) || '0.01';
    const negRisk = (await this.clob.getNegRisk(tokenId)) || false;
    const response = await this.clob.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        price,
        amount,
        side: Side.BUY,
        orderType: OrderType.FAK,
      },
      { tickSize, negRisk },
      OrderType.FAK,
    );
    return parseMarketResponse(response, 'BUY', amount);
  }
}

module.exports = PolymarketTrader;
