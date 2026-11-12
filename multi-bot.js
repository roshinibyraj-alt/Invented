'use strict';

const MispricingBot = require('./mispricing-bot');

class MultiBot {
  constructor(options = {}) {
    this.bot = options.bot || new MispricingBot(options);
  }

  start() {
    this.bot.start();
  }

  stop() {
    this.bot.stop();
  }

  snapshot() {
    return this.bot.snapshot();
  }

  diagnostics() {
    const state = this.snapshot();
    const trades = [...(state.trades || [])].reverse();
    const orders = [...(state.orders || [])].reverse();
    return {
      generatedAt: Date.now(),
      mode: 'DEMO ONLY',
      execution: 'PAPER ONLY',
      strategy: state.strategy,
      account: state.account,
      tradeCount: trades.length,
      orderAttempts: this.bot.totalOrderAttempts,
      retainedOrderCount: orders.length,
      trades,
      orders,
    };
  }
}

module.exports = MultiBot;
