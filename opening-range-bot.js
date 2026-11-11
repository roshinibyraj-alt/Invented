'use strict';

const cfg=require('./config');
const WickBot=require('./wick-bot');
const marketData=require('./wick-market-data');
const {quoteFromBook,takerFeeFor,feeContext}=WickBot._test;

const ASSETS=Object.freeze(['BTC','ETH']);
const EPSILON=1e-9;

function round(value){return Number(Number(value).toFixed(6))}

function emptySignal(asset){
  return {
    asset,
    indicatorStatus:'WAITING',
    setupStatus:'WAITING',
    direction:'WAITING',
    side:null,
    openingCandles:[],
    medianBodyPercent:null,
    confirmationBodyPercent:null,
    bodyMultiple:null,
    generatedAt:null,
    entryStatus:'WAITING_FOR_CONFIRMATION',
    lastReason:'Waiting for two completed one-minute candles.',
    triggeredAt:null,
    triggerAsk:null,
    filledAt:null,
    positionId:null,
    orderId:null,
    averagePrice:null,
    shares:0,
    fees:null,
  };
}

function normalizeLevels(levels){
  return (Array.isArray(levels)?levels:[])
    .map(level=>({price:Number(level.price),size:Number(level.size)}))
    .filter(level=>Number.isFinite(level.price)&&level.price>0&&level.price<1&&
      Number.isFinite(level.size)&&level.size>0)
    .sort((a,b)=>a.price-b.price);
}

function median(values){
  const sorted=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}

function bodyPercent(candle){
  const open=Number(candle?.open),close=Number(candle?.close);
  if(!Number.isFinite(open)||open<=0||!Number.isFinite(close))return null;
  return Math.abs(close-open)/open*100;
}

function analyzeOpeningRange(data,windowStart){
  const previous=Array.isArray(data?.previous)?data.previous:[];
  const opening=Array.isArray(data?.opening)?data.opening:[];
  if(previous.length<cfg.OPENING_RANGE_LOOKBACK||opening.length<cfg.OPENING_RANGE_CANDLES){
    throw new Error(`Opening-range analysis requires ${cfg.OPENING_RANGE_LOOKBACK} prior candles and ${cfg.OPENING_RANGE_CANDLES} window candles.`);
  }
  const baseline=previous.slice(-cfg.OPENING_RANGE_LOOKBACK);
  const [first,second]=opening.slice(0,cfg.OPENING_RANGE_CANDLES);
  if(Number(first.openTime)!==Number(windowStart)||
      Number(second.openTime)!==Number(windowStart)+60000){
    throw new Error('Opening candles are not aligned to the current five-minute window.');
  }
  const medianBodyPercent=median(baseline.map(bodyPercent).filter(value=>value!=null));
  const confirmationBodyPercent=bodyPercent(second);
  const bodyMultiple=medianBodyPercent>0
    ?confirmationBodyPercent/medianBodyPercent:null;
  const firstUp=Number(first.close)>Number(first.open);
  const secondUp=Number(second.close)>Number(second.open);
  const firstDown=Number(first.close)<Number(first.open);
  const secondDown=Number(second.close)<Number(second.open);
  const candidateSide=firstUp&&secondUp&&Number(second.close)>Number(first.high)
    ?'UP':firstDown&&secondDown&&Number(second.close)<Number(first.low)?'DOWN':null;
  const strongEnough=bodyMultiple!=null&&bodyMultiple>=cfg.BREAKOUT_BODY_MULTIPLE;
  const side=candidateSide&&strongEnough?candidateSide:null;
  const setupStatus=side?'READY':candidateSide?'WEAK_BREAKOUT':'NO_BREAKOUT';
  const lastReason=side
    ?`${side} breakout confirmed; second candle body is ${bodyMultiple.toFixed(2)}× the prior 20-candle median.`
    :candidateSide
      ?`${candidateSide} range break was too weak; body multiple ${bodyMultiple==null?'unavailable':bodyMultiple.toFixed(2)}×, minimum ${cfg.BREAKOUT_BODY_MULTIPLE.toFixed(2)}×.`
      :'The second candle did not close beyond the first candle range in the same direction.';
  return {
    indicatorStatus:'READY',
    setupStatus,
    direction:candidateSide||'NO BREAKOUT',
    side,
    candidateSide,
    firstCandle:first,
    secondCandle:second,
    openingCandles:[first,second],
    openingRangeHigh:Number(first.high),
    openingRangeLow:Number(first.low),
    medianBodyPercent:medianBodyPercent==null?null:round(medianBodyPercent),
    confirmationBodyPercent:confirmationBodyPercent==null?null:round(confirmationBodyPercent),
    bodyMultiple:bodyMultiple==null?null:round(bodyMultiple),
    generatedAt:Date.now(),
    lastReason,
  };
}

function sweepBook(levels,requestedShares,maxPrice){
  let remaining=requestedShares,notional=0;
  const fills=[];
  for(const level of normalizeLevels(levels)){
    if(Number.isFinite(maxPrice)&&level.price>maxPrice+EPSILON)break;
    if(remaining<=EPSILON)break;
    const shares=Math.min(remaining,level.size);
    const value=shares*level.price;
    notional+=value;
    remaining-=shares;
    fills.push({shares:round(shares),price:round(level.price),value:round(value)});
  }
  const filledShares=requestedShares-remaining;
  return {
    filledShares:round(filledShares),
    remainingShares:round(remaining),
    notional:round(notional),
    averagePrice:filledShares>0?round(notional/filledShares):null,
    fills,
  };
}

function feesFor(market,fills){
  return round(fills.reduce((sum,fill)=>sum+takerFeeFor(market,fill.price,fill.shares),0));
}

function planRiskSizedFill(market,levels,budget){
  const asks=normalizeLevels(levels);
  if(!asks.length)return {ok:false,reason:'NO_VISIBLE_ASKS'};
  const bestAsk=asks[0].price;
  if(bestAsk<cfg.MIN_ENTRY_PRICE||bestAsk>cfg.MAX_ENTRY_PRICE){
    return {ok:false,reason:'PRICE_OUTSIDE_BAND'};
  }
  const feeForOne=takerFeeFor(market,bestAsk,1);
  let requestedShares=Math.floor(budget/(bestAsk+feeForOne));
  if(requestedShares<cfg.MIN_ENTRY_SHARES){
    return {ok:false,reason:'BUDGET_TOO_SMALL'};
  }
  for(;requestedShares>=cfg.MIN_ENTRY_SHARES;requestedShares--){
    const fill=sweepBook(asks,requestedShares,cfg.MAX_ENTRY_PRICE);
    if(fill.filledShares+EPSILON<requestedShares)continue;
    const fees=feesFor(market,fill.fills);
    const debit=round(fill.notional+fees);
    if(debit<=budget+EPSILON)return {ok:true,requestedShares,fill,fees,debit};
  }
  return {ok:false,reason:'INSUFFICIENT_VISIBLE_DEPTH'};
}

class OpeningRangeBot extends WickBot{
  constructor({marketData:data=marketData}={}){
    super({
      timeframe:'5m',
      windowMs:cfg.WINDOW_MS_5M,
      capital:cfg.DEMO_CAPITAL,
      strategyId:'opening-range-breakout',
      strategyName:'BTC/ETH 5-minute opening-range breakout paper strategy',
      rules:{sharesPerSide:0},
      marketData:data,
    });
    this.crossAssetData=data;
    this.btcMarket=null;
    this.btcLiveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
    this.assetSignals=Object.fromEntries(ASSETS.map(asset=>[asset,emptySignal(asset)]));
    this.signalWindowStart=null;
    this.signalPromise=null;
  }

  async loadMarket(start,windowMs){
    if(Number(this.btcMarket?.start)!==Number(start)){
      this.btcLiveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
    }
    const [btcMarket,ethMarket]=await Promise.all([
      this.crossAssetData.getBtcMarket(start,windowMs),
      this.crossAssetData.getEthMarket(start,windowMs),
    ]);
    this.btcMarket=btcMarket;
    if(!btcMarket||!ethMarket)return null;
    if(Number(btcMarket.start)!==Number(ethMarket.start)){
      throw new Error('BTC and ETH markets do not share the same five-minute window start.');
    }
    return ethMarket;
  }

  async refreshLiveQuotes(now){
    await super.refreshLiveQuotes(now);
    if(!this.btcMarket){
      this.btcLiveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
      return;
    }
    const sides=['UP','DOWN'];
    const results=await Promise.allSettled(
      sides.map(side=>this.crossAssetData.getBook(this.btcMarket.tokens[side])),
    );
    for(const [index,side] of sides.entries()){
      const result=results[index];
      if(result.status==='fulfilled'){
        this.btcLiveQuotes[side]=quoteFromBook(result.value,now);
      }else{
        const previous=this.btcLiveQuotes[side]||{};
        const stale=!previous.updatedAt||now-previous.updatedAt>10000;
        this.btcLiveQuotes[side]={
          ...previous,
          status:previous.updatedAt?(stale?'STALE':'LIVE'):'ERROR',
          stale,
          attemptedAt:now,
          error:result.reason?.message||'BTC order book unavailable.',
        };
      }
    }
    for(const position of this.positions){
      if(position.asset!=='BTC'||position.status!=='OPEN'||
          position.windowStart!==this.market?.start)continue;
      const quote=this.btcLiveQuotes[position.side];
      position.markBid=quote?.bestBid??null;
      position.markUpdatedAt=quote?.updatedAt||now;
      position.markStatus=quote?.bestBid!=null?'LIVE':'MISSING';
    }
  }

  openStrategyWindow(start,now){
    super.openStrategyWindow(start,now);
    this.signalWindowStart=start;
    this.signalPromise=null;
    this.assetSignals=Object.fromEntries(ASSETS.map(asset=>[asset,emptySignal(asset)]));
  }

  marketFor(asset){return asset==='BTC'?this.btcMarket:this.market}

  quotePairFor(asset){
    return asset==='BTC'?this.btcLiveQuotes:this.liveQuotes;
  }

  isFreshQuote(quote,now){
    const age=now-Number(quote?.updatedAt);
    return quote?.status==='LIVE'&&!quote?.stale&&
      Number.isFinite(Number(quote.bestAsk))&&Number(quote.bestAsk)>0&&Number(quote.bestAsk)<1&&
      Number.isFinite(Number(quote.updatedAt))&&age>=0&&age<=cfg.MAX_QUOTE_AGE_MS;
  }

  async loadWindowSignals(start,now){
    await Promise.all(ASSETS.map(async asset=>{
      const state=this.assetSignals[asset];
      try{
        const candles=await this.crossAssetData.getOpeningRangeCandles(asset,start,now);
        const analysis=analyzeOpeningRange(candles,start);
        Object.assign(state,analysis,{
          asset,
          indicatorStatus:'READY',
          entryStatus:analysis.side?'WAITING_FOR_FRESH_BOOK':
            analysis.setupStatus==='WEAK_BREAKOUT'?'NO_TRADE_WEAK_BREAKOUT':'NO_TRADE_NO_BREAKOUT',
          lastReason:analysis.lastReason,
        });
        this.log('OPENING_RANGE_ANALYZED',{
          asset,
          side:analysis.side,
          setupStatus:analysis.setupStatus,
          bodyMultiple:analysis.bodyMultiple,
          medianBodyPercent:analysis.medianBodyPercent,
          windowStart:start,
        });
      }catch(error){
        Object.assign(state,{
          indicatorStatus:'UNAVAILABLE',
          setupStatus:'UNAVAILABLE',
          direction:'UNAVAILABLE',
          side:null,
          openingCandles:[],
          generatedAt:now,
          entryStatus:'NO_TRADE_DATA',
          lastReason:error?.message||'Could not load completed one-minute candles.',
        });
        this.log('OPENING_RANGE_UNAVAILABLE',{
          asset,note:state.lastReason,windowStart:start,
        });
      }
    }));
  }

  async processStrategyEntry(now){
    const start=this.orderWindowStart;
    if(!this.market||!this.btcMarket||Number(this.market.start)!==Number(start)||
        Number(this.btcMarket.start)!==Number(start)||this.completedWindows.has(start))return false;
    const elapsed=now-Number(start);
    if(elapsed<cfg.SIGNAL_READY_AFTER_MS)return false;
    if(elapsed>cfg.ENTRY_CUTOFF_MS){
      for(const state of Object.values(this.assetSignals)){
        if(state.side&&!['FILLED','NO_TRADE_DATA'].includes(state.entryStatus)&&
            !state.entryStatus.startsWith('NO_TRADE')){
          state.entryStatus='NO_TRADE_CUTOFF';
          state.lastReason='The three-minute entry cutoff passed; no late chase is allowed.';
        }
      }
      return false;
    }
    if(this.signalWindowStart!==start){
      this.signalWindowStart=start;
      this.assetSignals=Object.fromEntries(ASSETS.map(asset=>[asset,emptySignal(asset)]));
      this.signalPromise=null;
    }
    if(!this.signalPromise)this.signalPromise=this.loadWindowSignals(start,now);
    await this.signalPromise;
    if(Number(this.orderWindowStart)!==Number(start)||this.completedWindows.has(start))return false;
    const scanNow=Math.max(now,Date.now());
    if(scanNow-Number(start)>cfg.ENTRY_CUTOFF_MS){
      for(const state of Object.values(this.assetSignals)){
        if(state.side&&!['FILLED','NO_TRADE_DATA'].includes(state.entryStatus)&&
            !state.entryStatus.startsWith('NO_TRADE')){
          state.entryStatus='NO_TRADE_CUTOFF';
          state.lastReason='The three-minute entry cutoff passed while the signal was loading; no late chase is allowed.';
        }
      }
      return false;
    }

    let changed=false;
    for(const asset of ASSETS){
      const state=this.assetSignals[asset];
      if(state.indicatorStatus!=='READY'||!state.side||
          ['FILLED','NO_TRADE_DATA','NO_TRADE_CUTOFF','NO_TRADE_WEAK_BREAKOUT',
            'NO_TRADE_NO_BREAKOUT','BLOCKED_INSUFFICIENT_CASH'].includes(state.entryStatus)){
        continue;
      }
      if(this.positions.some(position=>position.asset===asset&&
          Number(position.windowStart)===Number(start)&&
          !['CANCELLED_UNFILLED'].includes(position.status))){
        state.entryStatus='FILLED';
        state.lastReason='This asset already has a position in the current window.';
        continue;
      }
      const market=this.marketFor(asset);
      const quotes=this.quotePairFor(asset);
      const quote=quotes?.[state.side];
      if(!market||!this.isFreshQuote(quote,scanNow)){
        state.entryStatus='WAITING_FOR_FRESH_BOOK';
        state.lastReason='Waiting for a fresh Polymarket ask and bid.';
        continue;
      }
      const ask=Number(quote.bestAsk),bid=Number(quote.bestBid);
      if(ask<cfg.MIN_ENTRY_PRICE||ask>cfg.MAX_ENTRY_PRICE){
        state.entryStatus='WAITING_FOR_PRICE_BAND';
        state.lastReason=`Waiting for the signaled-side ask to enter $${cfg.MIN_ENTRY_PRICE.toFixed(2)}–$${cfg.MAX_ENTRY_PRICE.toFixed(2)}.`;
        continue;
      }
      if(!Number.isFinite(bid)||bid<=0||bid>ask||ask-bid>cfg.MAX_ENTRY_SPREAD){
        state.entryStatus='WAITING_FOR_TIGHT_SPREAD';
        state.lastReason=`Spread must be no wider than $${cfg.MAX_ENTRY_SPREAD.toFixed(2)}.`;
        continue;
      }
      if(state.triggeredAt==null){
        state.triggeredAt=scanNow;
        state.triggerAsk=round(ask);
      }
      const budget=Math.min(cfg.ENTRY_BUDGET_PER_ASSET,this.cash);
      if(budget<=0){
        state.entryStatus='BLOCKED_INSUFFICIENT_CASH';
        state.lastReason='Paper cash is depleted.';
        continue;
      }
      const plan=planRiskSizedFill(market,quote.askLevels,budget);
      if(!plan.ok){
        if(plan.reason==='BUDGET_TOO_SMALL'){
          state.entryStatus='BLOCKED_INSUFFICIENT_CASH';
          state.lastReason=`At least ${cfg.MIN_ENTRY_SHARES} shares are required within the $${budget.toFixed(2)} risk cap.`;
        }else{
          state.entryStatus='WAITING_FOR_FULL_DEPTH';
          state.lastReason=`Waiting for enough fresh ask depth to fill at least ${cfg.MIN_ENTRY_SHARES} shares without exceeding the $${cfg.MAX_ENTRY_PRICE.toFixed(2)} price cap or $${budget.toFixed(2)} budget.`;
        }
        continue;
      }
      this.recordFill(asset,state,market,quotes,quote,plan,scanNow,start);
      changed=true;
    }
    this.lastScanAt=now;
    return changed;
  }

  recordFill(asset,state,market,quotes,quote,plan,now,start){
    const side=state.side,shares=plan.requestedShares;
    const positionId=`${start}-${asset.toLowerCase()}-${side.toLowerCase()}`;
    const orderId=`${positionId}-buy`;
    const fillEvents=plan.fill.fills.map(fill=>({
      filledAt:now,
      shares:fill.shares,
      price:fill.price,
      cost:fill.value,
      fee:round(takerFeeFor(market,fill.price,fill.shares)),
      source:'VISIBLE_ASK_DEPTH',
    }));
    const order={
      id:orderId,
      timeframe:this.timeframe,
      windowStart:start,
      marketId:market.id,
      marketSlug:market.slug,
      asset,
      tokenId:market.tokens[side],
      side,
      action:'BUY',
      kind:'OPENING_RANGE_BREAKOUT',
      orderType:'MARKET',
      requestedShares:shares,
      filledShares:shares,
      remainingShares:0,
      cost:plan.fill.notional,
      fee:plan.fees,
      averagePrice:plan.fill.averagePrice,
      fillEvents,
      maxPricePerShare:cfg.MAX_ENTRY_PRICE,
      createdAt:now,
      submittedAt:now,
      filledAt:now,
      status:'FILLED',
      positionId,
      positionIds:[positionId],
    };
    const position={
      id:positionId,
      timeframe:this.timeframe,
      windowMs:this.windowMs,
      windowStart:start,
      marketId:market.id,
      slug:market.slug,
      title:market.title,
      asset,
      side,
      tokenId:market.tokens[side],
      signalDirection:side,
      signalScore:state.bodyMultiple,
      signalSensitivity:cfg.BREAKOUT_BODY_MULTIPLE,
      signalLookback:cfg.OPENING_RANGE_LOOKBACK,
      entryGate:'TWO_CANDLE_BREAKOUT',
      entryThreshold:cfg.MAX_ENTRY_PRICE,
      triggerAsk:state.triggerAsk,
      entryKey:orderId,
      entryLabel:`${asset} ${side} · opening-range breakout`,
      entryMode:'OPENING_RANGE_BREAKOUT',
      entryType:'MARKET_TAKER_BUY',
      strategyId:this.strategyId,
      strategyName:this.strategyName,
      orderType:'MARKET',
      fillModel:'PAPER_VISIBLE_ASK_DEPTH_FULL_FILL',
      shares,
      initialShares:shares,
      requestedShares:shares,
      maxEntryPrice:cfg.MAX_ENTRY_PRICE,
      avgEntry:plan.fill.averagePrice,
      fillPrice:plan.fill.averagePrice,
      cost:plan.fill.notional,
      totalCost:plan.fill.notional,
      initialTotalCost:plan.fill.notional,
      fees:plan.fees,
      initialFees:plan.fees,
      exitFees:0,
      exitProceeds:0,
      estimatedMakerRebate:0,
      status:'OPEN',
      submittedAt:now,
      openedAt:now,
      filledAt:now,
      updatedAt:now,
      entryFillEvents:fillEvents,
      entryQuotes:this.captureQuotePair(now,quotes),
      entryQuoteAt:now,
      feeContext:feeContext(market),
      markBid:quote.bestBid??null,
      markUpdatedAt:quote.updatedAt||now,
      markStatus:'LIVE',
      maxObservedBidSizeByPrice:{},
      breakout:{
        openingRangeHigh:state.openingRangeHigh,
        openingRangeLow:state.openingRangeLow,
        confirmationBodyMultiple:state.bodyMultiple,
        medianBodyPercent:state.medianBodyPercent,
      },
    };
    this.cash=round(this.cash-plan.debit);
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    this.positions.unshift(position);
    this.totalOrderAttempts+=1;
    Object.assign(state,{
      entryStatus:'FILLED',
      filledAt:now,
      positionId,
      orderId,
      averagePrice:plan.fill.averagePrice,
      fees:plan.fees,
      shares,
      lastReason:`Filled ${shares} ${asset} ${side} shares at ${priceText(plan.fill.averagePrice)} average; total debit ${moneyText(plan.debit)} within the $${cfg.ENTRY_BUDGET_PER_ASSET.toFixed(2)} cap.`,
    });
    this.entryTriggerLatched=true;
    this.entryTriggerAt=state.triggeredAt;
    this.entryTriggerSide=`${asset} ${side}`;
    this.entryOrderPlaced=true;
    this.entryOrderId=orderId;
    this.entryTriggerReason=`${asset} ${side} opening-range breakout confirmed.`;
    this.entrySignal={
      asset,
      side,
      bodyMultiple:state.bodyMultiple,
      triggerAsk:state.triggerAsk,
      maxEntryPrice:cfg.MAX_ENTRY_PRICE,
      triggeredAt:state.triggeredAt,
    };
    this.log('PAPER_BREAKOUT_ENTRY_FILLED',{
      positionId,orderId,asset,side,sharesBought:shares,
      averageFillPrice:plan.fill.averagePrice,entryCost:plan.fill.notional,
      fees:plan.fees,totalDebit:plan.debit,bodyMultiple:state.bodyMultiple,
      windowStart:start,
    });
  }

  snapshot(){
    const state=super.snapshot();
    const now=Date.now();
    const start=Number(state.window?.start);
    const elapsedMs=Number.isFinite(start)?now-start:null;
    const windowOpen=elapsedMs!=null&&elapsedMs>=0&&elapsedMs<this.windowMs;
    const signals=Object.fromEntries(ASSETS.map(asset=>{
      const source=this.assetSignals[asset]||emptySignal(asset);
      const market=this.marketFor(asset);
      const quotes=this.captureQuotePair(now,this.quotePairFor(asset));
      const quote=source.side?quotes[source.side]:null;
      return [asset,{
        ...source,
        asset,
        marketId:market?.id||null,
        marketSlug:market?.slug||null,
        quotes,
        entry:{
          status:source.entryStatus,
          side:source.side,
          currentAsk:quote?.bestAsk??null,
          triggerAsk:source.triggerAsk,
          triggeredAt:source.triggeredAt,
          filledAt:source.filledAt,
          positionId:source.positionId,
          orderId:source.orderId,
          averagePrice:source.averagePrice,
          fees:source.fees,
          shares:source.shares||0,
          lastReason:source.lastReason,
          elapsedMs,
          timeRemainingMs:windowOpen?Math.max(0,this.windowMs-elapsedMs):0,
        },
      }];
    }));
    const btcPrices=this.captureQuotePair(now,this.btcLiveQuotes);
    const ethPrices=state.livePrices;
    const reasons=Object.values(signals).map(signal=>`${signal.asset}: ${signal.lastReason}`).join(' ');
    const pendingResolutionPositions=this.positions.filter(position=>
      position.status==='PENDING_RESOLUTION').length;
    const strategy={
      id:this.strategyId,
      name:this.strategyName,
      timeframe:'5m',
      market:'Polymarket BTC and ETH 5-minute UP/DOWN',
      capital:this.capital,
      execution:'PAPER ONLY',
      signal:{
        name:'Two-candle opening-range breakout',
        source:'Completed Binance 1-minute candles',
        openingCandles:cfg.OPENING_RANGE_CANDLES,
        baselineCandles:cfg.OPENING_RANGE_LOOKBACK,
        minimumBodyMultiple:cfg.BREAKOUT_BODY_MULTIPLE,
        readyAfterMs:cfg.SIGNAL_READY_AFTER_MS,
        output:'Directional setup, not a probability.',
      },
      entries:{
        orderType:'MARKET',
        maximumEntriesPerAssetPerWindow:1,
        maxRiskPerPosition:cfg.ENTRY_BUDGET_PER_ASSET,
        minShares:cfg.MIN_ENTRY_SHARES,
        minPrice:cfg.MIN_ENTRY_PRICE,
        maxPrice:cfg.MAX_ENTRY_PRICE,
        maxSpread:cfg.MAX_ENTRY_SPREAD,
        maxQuoteAgeMs:cfg.MAX_QUOTE_AGE_MS,
        entryCutoffMs:cfg.ENTRY_CUTOFF_MS,
        fillPolicy:'Size to the $15 cost-plus-fee cap; fill only from fresh visible asks up to the price cap. No partial or timeout fills.',
      },
      settlement:{
        intraWindowSells:false,
        resolutionPollIntervalMs:cfg.RESOLUTION_POLL_MS,
        windowEnd:'All filled shares wait for confirmed resolution of their exact original BTC or ETH market.',
      },
      timing:'Wait for two completed one-minute candles, then allow entries until three minutes into the five-minute market.',
      trigger:'The first candle defines the range. The next candle must close beyond that range in the same direction, with body size at least 1.25 times the prior 20-candle median.',
      sizing:`At most $${cfg.ENTRY_BUDGET_PER_ASSET.toFixed(2)} total cost including fees per asset; no adds or martingale.`,
      executionNote:'Demo-only simulation. No live orders are sent; positions are held to exact-market resolution.',
    };
    return {
      ...state,
      status:this.error?'blocked_or_error':
        this.positions.some(position=>position.windowStart===start&&position.status==='OPEN')
          ?'position_open':state.status,
      account:{
        ...state.account,
        openPositions:this.positions.filter(position=>
          ['OPEN','PENDING_RESOLUTION'].includes(position.status)).length,
        pendingResolutionPositions,
      },
      strategy,
      btcPrices:{
        marketSlug:this.btcMarket?.slug||null,
        marketId:this.btcMarket?.id||null,
        updatedAt:Math.max(btcPrices.UP.updatedAt||0,btcPrices.DOWN.updatedAt||0)||null,
        UP:btcPrices.UP,
        DOWN:btcPrices.DOWN,
      },
      livePrices:ethPrices,
      signals,
      signal:{ready:Object.values(signals).some(signal=>signal.indicatorStatus==='READY'),
        reason:reasons},
      entryWindow:{
        elapsedMs,
        waiting:elapsedMs==null||elapsedMs<cfg.SIGNAL_READY_AFTER_MS,
        open:windowOpen,
        windowOpen,
        cutoffReached:elapsedMs!=null&&elapsedMs>cfg.ENTRY_CUTOFF_MS,
        secondsUntilOpen:0,
        secondsRemaining:windowOpen?Math.ceil((this.windowMs-elapsedMs)/1000):0,
        secondsToWindowEnd:windowOpen?Math.ceil((this.windowMs-elapsedMs)/1000):0,
      },
      scanner:{
        timeframe:'5m',
        lastScanAt:this.lastScanAt,
        source:'Binance BTC/ETH 1-minute candles and Polymarket Gamma/CLOB order books',
        marketResolution:'Positions settle only against the confirmed result of their exact original BTC or ETH market.',
        resolutionPollIntervalMs:cfg.RESOLUTION_POLL_MS,
      },
    };
  }
}

function priceText(value){return Number.isFinite(Number(value))?`$${Number(value).toFixed(2)}`:'—'}
function moneyText(value){return Number.isFinite(Number(value))?`$${Number(value).toFixed(2)}`:'—'}

OpeningRangeBot.constants={ASSETS};
OpeningRangeBot._test={analyzeOpeningRange,bodyPercent,median,sweepBook,planRiskSizedFill};

module.exports=OpeningRangeBot;
