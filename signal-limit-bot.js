'use strict';

const cfg=require('./config');
const WickBot=require('./wick-bot');
const {makerRebateFor,feeContext}=WickBot._test;
const {feed:defaultCandleFeed}=require('./chainlink-feed');

function oppositeSide(side){
  return side==='UP'?'DOWN':side==='DOWN'?'UP':null;
}

class SignalLimitBot extends WickBot {
  constructor({candleFeed=defaultCandleFeed}={}){
    super({
      timeframe:'5m',
      windowMs:cfg.WINDOW_MS_5M,
      capital:cfg.DEMO_CAPITAL,
      strategyId:'btc-5m-signal',
      strategyName:'57-second BTC signal limit strategy',
    });
    this.baseCapital=cfg.DEMO_CAPITAL;
    this.baseShareSize=cfg.ENTRY_SHARES;
    this.variantProfitTarget=cfg.VARIANT_PROFIT_TARGET;
    this.capital=this.baseCapital*2;
    this.cash=this.capital;
    this.activeVariantId='signal';
    this.variants={
      signal:{id:'signal',name:'With signal',mode:'SIGNAL',startingCapital:this.baseCapital,
        cash:this.baseCapital,shareSize:this.baseShareSize,cycleNumber:1,cycleProfit:0,
        active:true,activatedAt:this.startedAt,settledTrades:0,wins:0,losses:0,equityCurve:[]},
      against:{id:'against',name:'Against signal',mode:'AGAINST_SIGNAL',startingCapital:this.baseCapital,
        cash:this.baseCapital,shareSize:this.baseShareSize,cycleNumber:0,cycleProfit:0,
        active:false,activatedAt:null,settledTrades:0,wins:0,losses:0,equityCurve:[]},
    };
    for(const variant of Object.values(this.variants))
      variant.equityCurve=[{ts:this.startedAt,equity:variant.startingCapital}];
    this.candleFeed=candleFeed;
    this.lastCandleWaitLogAt=0;
  }

  getTradeSide(signalSide,variantId=this.activeVariantId){
    const variant=this.variants[variantId];
    if(variant?.mode==='SIGNAL')return signalSide;
    return oppositeSide(signalSide);
  }

  switchVariantAfterTarget(variant,now){
    if(this.activeVariantId!==variant.id||variant.cycleProfit<this.variantProfitTarget)return false;
    for(const order of this.orders){
      if(order.variantId!==variant.id||order.windowStart!==this.market?.start
        ||!['PENDING','PARTIALLY_FILLED'].includes(order.status)||order.remainingShares<=0)continue;
      order.cancelledRemainderShares=order.remainingShares;
      order.remainingShares=0;
      order.status='CANCELLED_VARIANT_PAUSED';
      order.cancelledAt=now;
      this.log('PAPER_ENTRY_CANCELLED_VARIANT_PAUSED',{
        orderId:order.id,variantId:variant.id,cancelledShares:order.cancelledRemainderShares,
      });
    }
    const nextId=variant.id==='signal'?'against':'signal';
    variant.active=false;
    variant.shareSize=this.baseShareSize;
    const next=this.variants[nextId];
    next.cycleNumber+=1;
    next.cycleProfit=0;
    next.shareSize=nextId==='against'?this.baseShareSize*2:this.baseShareSize;
    next.active=true;
    next.activatedAt=now;
    this.activeVariantId=nextId;
    this.log('PAPER_VARIANT_TARGET_REACHED',{
      targetProfit:this.variantProfitTarget,completedVariantId:variant.id,
      completedVariantProfit:variant.cycleProfit,activatedVariantId:next.id,
      activatedShareSize:next.shareSize,cycleNumber:next.cycleNumber,
    });
    return true;
  }

  finalizeResolution(position,winner,now=Date.now()){
    const finalized=super.finalizeResolution(position,winner,now);
    if(!finalized)return false;
    const variant=this.variants[position.variantId];
    if(!variant)return true;
    variant.cash+=Number(position.proceeds)||0;
    variant.settledTrades+=1;
    if(position.realizedPnl>0)variant.wins+=1;
    else if(position.realizedPnl<0)variant.losses+=1;
    if(position.cycleNumber===variant.cycleNumber){
      variant.cycleProfit=Number((variant.cycleProfit+position.realizedPnl).toFixed(6));
    }
    const curveLast=variant.equityCurve.at(-1)?.equity??variant.startingCapital;
    variant.equityCurve.push({ts:now,equity:Number((curveLast+position.realizedPnl).toFixed(6))});
    if(variant.equityCurve.length>1000)variant.equityCurve.splice(1,variant.equityCurve.length-1000);
    this.switchVariantAfterTarget(variant,now);
    return true;
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
    const signalSide=this.entryTriggerSide;
    const variant=this.variants[this.activeVariantId];
    const side=this.getTradeSide(signalSide,variant.id);
    if(!side){
      this.entryAttemptMissed=true;
      this.log('PAPER_SIGNAL_ENTRY_SKIPPED',{strategyId:this.strategyId,
        windowStart:start,signalSide,reason:'The latched signal has no valid opposite outcome side.'});
      return;
    }
    const id=`${this.strategyId}-${variant.id}-${this.timeframe}-${start}-${side.toLowerCase()}-entry`;
    const order={
      id,timeframe:this.timeframe,windowStart:start,side,signalSide,action:'BUY',kind:'ENTRY',
      variantId:variant.id,variantName:variant.name,cycleNumber:variant.cycleNumber,
      strategyId:this.strategyId,tokenId:this.market.tokens?.[side]||null,
      orderType:'LIMIT',entryMode:'CANDLE_SIGNAL_LIMIT_BUY',entryType:'LIMIT_MAKER_BUY',
      limitPrice:this.rules.entryLimitPrice,requestedShares:variant.shareSize,
      shares:variant.shareSize,filledShares:0,remainingShares:variant.shareSize,
      createdAt:now,submittedAt:now,fillEvents:[],maxObservedAskSizeByPrice:{},
      expiresAt:start+this.windowMs,status:'PENDING',fee:0,estimatedMakerRebate:0,
    };
    this.entryOrderPlaced=true;
    this.entryOrderId=id;
    this.totalOrderAttempts++;
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.log('PAPER_SIGNAL_LIMIT_ORDER_PLACED',{
      id,variantId:variant.id,variantName:variant.name,cycleNumber:variant.cycleNumber,
      side,signalSide,limitPrice:order.limitPrice,shares:order.shares,
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
    const variant=this.variants[order.variantId];
    const availableCash=variant?.cash??this.cash;
    if(cost>availableCash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';
      order.reason='The paper balance cannot fund the limit-order fill.';
      order.remainingShares=0;
      this.log('PAPER_SIGNAL_LIMIT_ORDER_REJECTED',{
        id:order.id,side:order.side,limitPrice:order.limitPrice,
        availableCash,reason:order.reason,
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
         side:order.side,signalSide:order.signalSide,variantId:order.variantId,
        variantName:order.variantName,cycleNumber:order.cycleNumber,
        tokenId:order.tokenId,entryKey:order.id,
        entryLabel:`${order.side} $${order.limitPrice.toFixed(2)} signal limit · ${order.requestedShares} shares`,
        entryMode:order.entryMode,entryType:order.entryType,phase:'signal-limit',
        entryFillSource:fillSource,
        strategyId:this.strategyId,strategyName:order.variantName,
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
    if(variant)variant.cash=Number((variant.cash-cost+rebate).toFixed(6));

    this.log('PAPER_SIGNAL_LIMIT_VISIBLE_ASK_FILLED',{
      id:order.id,positionId:position.id,side:order.side,shares:safeShares,
      fillPrice:safePrice,limitPrice:order.limitPrice,fillSource,cost,fees:0,
      makerRebateCredited:rebate,remainingShares:order.remainingShares,
    });
    return position;
  }

  snapshot(){
    const state=super.snapshot();
    const variants=Object.fromEntries(Object.entries(this.variants).map(([id,variant])=>{
      const positions=this.positions.filter(position=>position.variantId===id);
      const open=positions.filter(position=>['OPEN','PENDING_RESOLUTION'].includes(position.status));
      const settled=positions.filter(position=>position.status==='SETTLED_EXIT');
      const openCost=open.reduce((sum,position)=>sum+(Number(position.totalCost)||0),0);
      const realizedPnl=variant.cash+openCost-variant.startingCapital;
      const allMarked=open.every(position=>Number.isFinite(position.markValue));
      const markedValue=allMarked?open.reduce((sum,position)=>sum+(Number(position.markValue)||0),0):null;
      const curve=[{ts:this.startedAt,equity:variant.startingCapital}];
      let equity=variant.startingCapital;
      for(const position of settled.slice().sort((a,b)=>(a.settledAt||0)-(b.settledAt||0))){
        equity+=Number(position.realizedPnl)||0;
        curve.push({ts:position.settledAt||position.openedAt,equity});
      }
      return [id,{
        id,name:variant.name,mode:variant.mode,active:variant.active,
        status:variant.active?'ACTIVE':'PAUSED',shareSize:variant.shareSize,
        baseShareSize:this.baseShareSize,targetProfit:this.variantProfitTarget,
        cycleNumber:variant.cycleNumber,cycleProfit:variant.cycleProfit,
        remainingToTarget:Math.max(0,this.variantProfitTarget-variant.cycleProfit),
        startingCapital:variant.startingCapital,cash:variant.cash,
        realizedPnl,wins:variant.wins,losses:variant.losses,
        settledTrades:variant.settledTrades,
        winRate:variant.settledTrades?variant.wins/variant.settledTrades*100:0,
        totalTrades:positions.length,openPositions:open.length,
        markedValue,unrealizedPnl:markedValue==null?null:markedValue-openCost,
        equity:markedValue==null?null:variant.cash+markedValue,
        equityCurve:curve,
        positions:positions.slice().sort((a,b)=>(b.openedAt||0)-(a.openedAt||0)).slice(0,30),
      }];
    }));
    const active=this.variants[this.activeVariantId];
    const tradeSide=this.getTradeSide(this.entryTriggerSide,active.id);
    const strategy={
      ...state.strategy,
      name:'BTC 5-minute signal / against-signal target rotation',
      activeVariantId:this.activeVariantId,
      variantProfitTarget:this.variantProfitTarget,
      entries:{
        ...state.strategy.entries,
        sharesPerSide:active.shareSize,
        remainingShares:state.strategy.entries.orderPlaced
          ?state.strategy.entries.remainingShares:active.shareSize,
        sideSelection:active.mode==='SIGNAL'?'Trade on the candle signal side.':'Trade against the candle signal side.',
        signal:{...state.strategy.entries.signal,tradeSide},
      },
      trigger:`Active version ${active.name} trades ${active.mode==='SIGNAL'?'with':'against'} the candle signal.`,
      timing:`At window open, trade ${active.mode==='SIGNAL'?'with':'against'} the signal.`,
      sizing:`${active.shareSize} shares on the ${active.mode==='SIGNAL'?'signalled':'opposite'} side at a $${this.rules.entryLimitPrice.toFixed(2)} limit.`,
    };
    return {...state,strategy,activeVariantId:this.activeVariantId,variants};
  }
}

module.exports=SignalLimitBot;
