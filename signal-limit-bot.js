'use strict';

const cfg=require('./config');
const WickBot=require('./wick-bot');
const {makerRebateFor,feeContext}=WickBot._test;
const {feed:defaultCandleFeed}=require('./chainlink-feed');

class SignalLimitBot extends WickBot {
  constructor({candleFeed=defaultCandleFeed}={}){
    super({
      timeframe:'5m',
      windowMs:cfg.WINDOW_MS_5M,
      capital:cfg.DEMO_CAPITAL,
      strategyId:'btc-5m-signal',
      strategyName:'57-second BTC signal limit strategy',
    });
    this.candleFeed=candleFeed;
    this.lastCandleWaitLogAt=0;
  }

  getWindowStartToScan(now,currentStart){
    const nextStart=currentStart+this.windowMs;
    return nextStart-now>0&&nextStart-now<=this.rules.signalScanLeadMs
      ?nextStart:currentStart;
  }

  processStrategyEntry(now){
    const start=this.orderWindowStart;
    if(!this.market||this.market.start!==start||this.completedWindows.has(start)||
       this.entryAttemptMissed)return false;

    if(now<start){
      const signalAt=start-this.rules.signalCompareLeadMs;
      if(now>=signalAt&&!this.entryTriggerLatched)this.readCandleSignal(now,start,signalAt);
      return false;
    }

    if(!this.entryTriggerLatched||!this.entryTriggerSide){
      this.entryAttemptMissed=true;
      this.log('PAPER_SIGNAL_ENTRY_SKIPPED',{strategyId:this.strategyId,
        windowStart:start,reason:'The BTC candle signal was not ready before the market opened.'});
      return false;
    }

    if(!this.entryOrderPlaced)this.placeSignalLimitOrder(now,start);
    return this.processPendingSignalLimitOrder(now);
  }

  readCandleSignal(now,start,signalAt){
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
        ?`BTC rose above the previous closed 1-minute candle's $${referenceClose} close during the final 57 seconds; signal UP.`
        :`BTC was at or below the previous closed 1-minute candle's $${referenceClose} close during the final 57 seconds; signal DOWN.`;
      this.entryTriggerLatched=true;
      this.log('PAPER_57S_CANDLE_SIGNAL',{
        strategyId:this.strategyId,windowStart:start,signalAt,readAt:now,
        segmentStartAt:candleCloseAt,segmentEndAt:currentPriceAt,segmentSeconds:57,
        referenceCandleStart:Number(candle.t),referenceCandleClosedAt:candleCloseAt,
        referenceClose,currentPrice,currentPriceAt,side:this.entryTriggerSide,
      });
    }catch(error){
      if(!this.lastCandleWaitLogAt||now-this.lastCandleWaitLogAt>=5000){
        this.lastCandleWaitLogAt=now;
        this.log('PAPER_CANDLE_SIGNAL_WAIT',{strategyId:this.strategyId,
          windowStart:start,signalAt,reason:error?.message||'Candle feed unavailable'});
      }
    }
  }

  placeSignalLimitOrder(now,start){
    const side=this.entryTriggerSide;
    const id=`${this.strategyId}-${this.timeframe}-${start}-${side.toLowerCase()}-entry`;
    const order={
      id,timeframe:this.timeframe,windowStart:start,side,action:'BUY',kind:'ENTRY',
      strategyId:this.strategyId,tokenId:this.market.tokens?.[side]||null,
      orderType:'LIMIT',entryMode:'CANDLE_SIGNAL_LIMIT_BUY',entryType:'LIMIT_MAKER_BUY',
      limitPrice:this.rules.entryLimitPrice,requestedShares:this.rules.sharesPerSide,
      shares:this.rules.sharesPerSide,filledShares:0,remainingShares:this.rules.sharesPerSide,
      createdAt:now,submittedAt:now,fillEvents:[],maxObservedAskSizeByPrice:{},
      expiresAt:start+this.windowMs,status:'PENDING',fee:0,estimatedMakerRebate:0,
    };
    this.entryOrderPlaced=true;
    this.entryOrderId=id;
    this.totalOrderAttempts++;
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.log('PAPER_SIGNAL_LIMIT_ORDER_PLACED',{
      id,side,limitPrice:order.limitPrice,shares:order.shares,
      fillPolicy:'better-price asks only if present at submission; later resting fills at limit price',
      expiresAt:order.expiresAt,
    });
  }

  processPendingSignalLimitOrder(now){
    const order=this.orders.find(item=>item.id===this.entryOrderId);
    if(!order||!['PENDING','PARTIALLY_FILLED'].includes(order.status))return false;
    const position=order.positionId
      ?this.positions.find(item=>item.id===order.positionId):null;
    if(position&&position.status!=='OPEN'){
      order.status='CANCELLED_POSITION_CLOSED';
      order.cancelledAt=now;
      order.cancelledRemainderShares=order.remainingShares;
      order.remainingShares=0;
      return false;
    }
    if(now>=order.expiresAt){
      order.status='CANCELLED_WINDOW_END';
      order.expiredAt=now;
      order.cancelledRemainderShares=order.remainingShares;
      order.remainingShares=0;
      return false;
    }

    const quote=this.liveQuotes[order.side];
    const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&now-quote.updatedAt<=5000;
    let filled=false;
    if(fresh&&order.remainingShares>1e-9){
      const atSubmission=now===order.submittedAt;
      const observedLevels=(Array.isArray(quote.askLevels)&&quote.askLevels.length
        ?quote.askLevels:[{price:Number(quote.bestAsk),size:Number(quote.askSize)}])
        .map(level=>({price:Number(level.price),size:Number(level.size)}))
        .filter(level=>Number.isFinite(level.price)&&level.price>0&&
          Number.isFinite(level.size)&&level.size>0)
        .sort((a,b)=>a.price-b.price);
      const levels=[];
      for(const level of observedLevels){
        const key=level.price.toFixed(6);
        const previousMax=Number(order.maxObservedAskSizeByPrice[key]||0);
        const newlyObserved=atSubmission?level.size:Math.max(0,level.size-previousMax);
        order.maxObservedAskSizeByPrice[key]=Math.max(previousMax,level.size);
        if(level.price<=order.limitPrice&&newlyObserved>1e-9){
          levels.push({price:level.price,size:newlyObserved});
        }
      }
      for(const level of levels){
        if(order.remainingShares<=1e-9)break;
        const shares=Math.min(order.remainingShares,level.size);
        if(shares<=0)continue;
        level.size-=shares;
        const fillSource=atSubmission?'IMMEDIATE_MARKETABLE_LIMIT':'RESTING_LIMIT_MATCH';
        const fillPrice=atSubmission?level.price:order.limitPrice;
        this.applySignalLimitFill(order,shares,fillPrice,now,fillSource);
        filled=true;
      }
    }

    if(order.remainingShares<=1e-9){
      order.remainingShares=0;
      order.status='FILLED';
      order.filledAt=now;
    }else if(order.filledShares>0){
      order.status='PARTIALLY_FILLED';
    }
    return filled;
  }

  applySignalLimitFill(order,shares,price,now,fillSource){
    const safeShares=Number(shares.toFixed(6));
    const safePrice=Number(price.toFixed(6));
    const cost=Number((safeShares*safePrice).toFixed(6));
    const rebate=makerRebateFor(this.market,safePrice,safeShares).estimate;
    if(cost>this.cash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';
      order.reason='The paper balance cannot fund the limit-order fill.';
      order.remainingShares=0;
      this.log('PAPER_SIGNAL_LIMIT_ORDER_REJECTED',{
        id:order.id,side:order.side,limitPrice:order.limitPrice,
        availableCash:this.cash,reason:order.reason,
      });
      return null;
    }

    let position=order.positionId
      ?this.positions.find(item=>item.id===order.positionId):null;
    if(!position){
      const id=`${order.id}-position`;
      position={
        id,timeframe:this.timeframe,windowMs:this.windowMs,windowStart:order.windowStart,
        marketId:this.market.id,slug:this.market.slug,title:this.market.title,
        side:order.side,tokenId:order.tokenId,entryKey:order.id,
        entryLabel:`${order.side} $${order.limitPrice.toFixed(2)} signal limit · ${order.requestedShares} shares`,
        entryMode:order.entryMode,entryType:order.entryType,phase:'signal-limit',
        entryFillSource:fillSource,
        strategyId:this.strategyId,strategyName:this.strategyName,
        orderType:'LIMIT',fillModel:'PAPER_LIMIT_ORDER_BOOK_DEPTH',
        shares:0,requestedShares:order.requestedShares,initialShares:order.requestedShares,
        avgEntry:safePrice,fillPrice:safePrice,cost:0,totalCost:0,fees:0,exitFees:0,
        estimatedMakerRebate:0,status:'OPEN',submittedAt:order.submittedAt,
        openedAt:now,filledAt:now,visibleAskSize:this.liveQuotes[order.side]?.askSize||0,
        simulatedShares:0,entryQuotes:this.captureQuotePair(now),entryQuoteAt:now,
        feeContext:feeContext(this.market),
      };
      this.positions.unshift(position);
      order.positionId=id;
      order.positionIds=[id];
    }

    position.shares=Number((position.shares+safeShares).toFixed(6));
    position.cost=Number((position.cost+cost).toFixed(6));
    position.totalCost=position.cost;
    position.avgEntry=Number((position.cost/position.shares).toFixed(6));
    position.fillPrice=position.avgEntry;
    position.estimatedMakerRebate=Number((position.estimatedMakerRebate+rebate).toFixed(6));
    if(position.entryFillSource!==fillSource)position.entryFillSource='MIXED_LIMIT_FILL_SOURCES';
    position.updatedAt=now;
    position.visibleAskSize=this.liveQuotes[order.side]?.askSize||0;
    position.simulatedShares=position.shares;

    order.filledShares=Number((order.filledShares+safeShares).toFixed(6));
    order.remainingShares=Number(Math.max(0,order.requestedShares-order.filledShares).toFixed(6));
    order.cost=Number(((order.cost||0)+cost).toFixed(6));
    order.totalCost=order.cost;
    order.averagePrice=Number((order.cost/order.filledShares).toFixed(6));
    order.fillPrice=order.averagePrice;
    order.fee=0;
    order.estimatedMakerRebate=Number(((order.estimatedMakerRebate||0)+rebate).toFixed(6));
    order.lastFillAt=now;
    order.lastFillPrice=safePrice;
    order.lastFillShares=safeShares;
    order.lastFillSource=fillSource;
    order.fillEvents.push({filledAt:now,shares:safeShares,price:safePrice,source:fillSource});
    this.cash=Number((this.cash-cost+rebate).toFixed(6));

    this.log('PAPER_SIGNAL_LIMIT_VISIBLE_ASK_FILLED',{
      id:order.id,positionId:position.id,side:order.side,shares:safeShares,
      fillPrice:safePrice,limitPrice:order.limitPrice,fillSource,cost,fees:0,
      makerRebateCredited:rebate,remainingShares:order.remainingShares,
    });
    return position;
  }
}

module.exports=SignalLimitBot;
