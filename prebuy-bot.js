'use strict';

const cfg=require('./config');
const WickBot=require('./wick-bot');

class PrebuyBot extends WickBot {
  constructor(){
    super({
      timeframe:'5m',
      windowMs:cfg.WINDOW_MS_5M,
      capital:cfg.DEMO_CAPITAL_PREBUY,
      strategyId:'prebuy-5m',
      strategyName:'10-second paired pre-buy',
      rules:{
        entryWindowStartMs:-cfg.PREBUY_LEAD_MS,
        entryPriceMin:null,
        entryPriceMax:null,
        sharesPerSide:cfg.PREBUY_SHARES_PER_SIDE,
        takeProfitInitialPrice:cfg.PREBUY_TAKE_PROFIT_INITIAL_PRICE,
        takeProfitAfterOppositeHit:cfg.PREBUY_TAKE_PROFIT_AFTER_OPPOSITE_HIT,
        takeProfitPayout:cfg.TAKE_PROFIT_099_PAYOUT,
        takeProfitDelayMs:cfg.PREBUY_TAKE_PROFIT_DELAY_MS,
        prebuyLeadMs:cfg.PREBUY_LEAD_MS,
      },
    });
  }

  getWindowStartToScan(now,currentStart){
    const nextStart=currentStart+this.windowMs;
    return nextStart-now>0&&nextStart-now<=this.rules.prebuyLeadMs
      ?nextStart:currentStart;
  }

  processPairedEntry(now){
    const start=this.orderWindowStart;
    if(!this.market||this.market.start!==start||this.completedWindows.has(start)||
       this.entryPairPlaced||this.entryAttemptMissed)return false;
    if(now>=start){
      this.entryAttemptMissed=true;
      this.log('PAPER_PREBUY_SKIPPED_WINDOW_OPENED',{strategyId:this.strategyId,
        windowStart:start,reason:'Both fresh order books were not ready before window open.'});
      return false;
    }
    if(now<start-this.rules.prebuyLeadMs)return false;
    if(!this.entryTriggerLatched){
      this.entryTriggerLatched=true;
      this.entryTriggerAt=now;
    }
    const fresh=quote=>quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&
      now-quote.updatedAt<=5000&&Number(quote.bestAsk)>0&&Number(quote.bestAsk)<1;
    if(!fresh(this.liveQuotes.UP)||!fresh(this.liveQuotes.DOWN))return false;

    this.entryPairPlaced=true;
    this.totalOrderAttempts+=2;
    this.log('PAPER_PREBUY_TRIGGERED',{strategyId:this.strategyId,windowStart:start,
      scheduledAt:start-this.rules.prebuyLeadMs,triggeredAt:now,
      sharesPerSide:this.rules.sharesPerSide});
    return ['UP','DOWN'].map(side=>this.placePairedMarketBuy(side,now,start)).some(Boolean);
  }
}

module.exports=PrebuyBot;
