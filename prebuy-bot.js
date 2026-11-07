'use strict';

const cfg=require('./config');
const WickBot=require('./wick-bot');
const {feed:defaultCandleFeed}=require('./chainlink-feed');

class PrebuyBot extends WickBot {
  constructor({candleFeed=defaultCandleFeed}={}){
    super({
      timeframe:'5m',
      windowMs:cfg.WINDOW_MS_5M,
      capital:cfg.DEMO_CAPITAL_PREBUY,
      strategyId:'prebuy-5m',
      strategyName:'57-second BTC comparison pre-buy',
      rules:{
        entryWindowStartMs:-cfg.PREBUY_ORDER_LEAD_MS,
        sharesPerSide:cfg.PREBUY_SHARES_PER_SIDE,
        takeProfitInitialPrice:cfg.PREBUY_TAKE_PROFIT_INITIAL_PRICE,
        takeProfitAfterOppositeHit:cfg.PREBUY_TAKE_PROFIT_AFTER_OPPOSITE_HIT,
        takeProfitPayout:cfg.TAKE_PROFIT_099_PAYOUT,
        takeProfitDelayMs:cfg.PREBUY_TAKE_PROFIT_DELAY_MS,
        prebuyScanLeadMs:cfg.PREBUY_SCAN_LEAD_MS,
        prebuySignalLeadMs:cfg.PREBUY_SIGNAL_LEAD_MS,
        prebuyOrderLeadMs:cfg.PREBUY_ORDER_LEAD_MS,
        entryRungs:null,
      },
    });
    this.candleFeed=candleFeed;
    this.lastCandleWaitLogAt=0;
  }

  getWindowStartToScan(now,currentStart){
    const nextStart=currentStart+this.windowMs;
    return nextStart-now>0&&nextStart-now<=this.rules.prebuyScanLeadMs
      ?nextStart:currentStart;
  }

  processPairedEntry(now){
    const start=this.orderWindowStart;
    if(!this.market||this.market.start!==start||this.completedWindows.has(start)||
       this.entryPairPlaced||this.entryAttemptMissed)return false;
    if(now>=start){
      this.entryAttemptMissed=true;
      this.log('PAPER_PREBUY_SKIPPED_WINDOW_OPENED',{strategyId:this.strategyId,
        windowStart:start,reason:this.entryTriggerReason||
          'No valid candle signal and fresh side quote were ready before the window opened.'});
      return false;
    }
    if(now<start-this.rules.prebuyScanLeadMs)return false;
    const signalAt=start-this.rules.prebuySignalLeadMs;
    if(now>=signalAt&&!this.entryTriggerLatched){
      try{
        const candles=this.candleFeed.getMinuteCandles();
        const closed=candles.filter(candle=>Number.isFinite(Number(candle.t))&&
          Number(candle.t)+60000<=signalAt)
          .sort((a,b)=>Number(a.t)-Number(b.t));
        const candle=closed.at(-1);
        if(!candle)throw new Error('No previous closed one-minute BTC candle is available.');
        const candleCloseAt=Number(candle.t)+60000;
        if(signalAt-candleCloseAt>90000)
          throw new Error('The previous closed one-minute BTC candle is stale.');
        const referenceClose=Number(candle.c);
        if(!Number.isFinite(referenceClose))
          throw new Error('The previous closed one-minute candle has an invalid close.');
        const livePrice=this.candleFeed.getLatestPrice();
        const currentPrice=Number(livePrice?.price);
        const currentPriceAt=Number(livePrice?.timestamp);
        if(!Number.isFinite(currentPrice)||!Number.isFinite(currentPriceAt))
          throw new Error('The live Chainlink BTC price is unavailable.');
        if(currentPriceAt<=candleCloseAt||currentPriceAt>signalAt+1000)
          throw new Error('The live BTC price is outside the final 57-second signal segment.');
        this.entryTriggerAt=now;
        this.entryTriggerCandle={
          start:candleCloseAt,end:currentPriceAt,durationSeconds:57,
          referenceCandleStart:Number(candle.t),referenceCandleClosedAt:candleCloseAt,
          referenceClose,currentPrice,currentPriceAt,
        };
        this.entryTriggerSide=currentPrice>referenceClose?'UP':'DOWN';
        this.entryTriggerReason=currentPrice>referenceClose
          ?`BTC rose from the previous closed 1-minute candle's $${referenceClose} close during the final 57 seconds; signal UP.`
          :`BTC was at or below the previous closed 1-minute candle's $${referenceClose} close during the final 57 seconds; signal DOWN.`;
        this.entryTriggerLatched=true;
        this.log('PAPER_PREBUY_57S_SIGNAL',{
          strategyId:this.strategyId,windowStart:start,signalAt,readAt:now,
          segmentStartAt:candleCloseAt,segmentEndAt:currentPriceAt,
          segmentSeconds:57,referenceCandleStart:Number(candle.t),
          referenceCandleClosedAt:candleCloseAt,referenceClose,currentPrice,
          currentPriceAt,side:this.entryTriggerSide});
      }catch(error){
        if(!this.lastCandleWaitLogAt||now-this.lastCandleWaitLogAt>=5000){
          this.lastCandleWaitLogAt=now;
          this.log('PAPER_PREBUY_CANDLE_WAIT',{strategyId:this.strategyId,
            windowStart:start,signalAt,reason:error?.message||'Candle feed unavailable'});
        }
        return false;
      }
    }
    if(!this.entryTriggerSide)return false;
    const orderAt=start-this.rules.prebuyOrderLeadMs;
    if(now<orderAt)return false;
    const quote=this.liveQuotes[this.entryTriggerSide];
    const fresh=quote=>quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&
      now-quote.updatedAt<=5000&&Number(quote.bestAsk)>0&&Number(quote.bestAsk)<1;
    if(!fresh(quote))return false;

    this.entryPairPlaced=true;
    this.totalOrderAttempts++;
    this.log('PAPER_PREBUY_TRIGGERED',{strategyId:this.strategyId,windowStart:start,
      candleSide:this.entryTriggerSide,candle:this.entryTriggerCandle,
      scheduledAt:orderAt,triggeredAt:now,shares:this.rules.sharesPerSide});
    return this.placeMarketBuy(this.entryTriggerSide,now,start,{
      entryMode:'ONE_MINUTE_CANDLE_PREBUY',
      entryType:'CLOSED_CANDLE_SIGNAL_TAKER_BUY',
      idSuffix:'candle-prebuy',
      entryLabel:`${this.entryTriggerSide} candle-signal market buy`,
    });
  }
}

module.exports=PrebuyBot;
