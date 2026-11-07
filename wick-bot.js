'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');

function levels(xs){return (xs||[]).map(x=>({price:Number(x.price),size:Number(x.size)}))
  .filter(x=>Number.isFinite(x.price)&&x.size>0).sort((a,b)=>a.price-b.price)}
function usdPrice(x){return '$'+Number(x).toFixed(2)}
function quoteFromBook(book,updatedAt){
  const bids=levels(book.bids).sort((a,b)=>b.price-a.price);
  const asks=levels(book.asks).sort((a,b)=>a.price-b.price);
  const bid=bids[0]||null;
  const ask=asks[0]||null;
  const bestBid=bid?.price??null,bestAsk=ask?.price??null;
  return {status:bid||ask?'LIVE':'MISSING',bestBid,bidSize:bid?.size??0,
    bestAsk,askSize:ask?.size??0,mid:bestBid!=null&&bestAsk!=null?(bestBid+bestAsk)/2:null,
    askLevels:asks,updatedAt,stale:false,error:null};
}
function takeAsks(quote,shares,market){
  const askLevels=Array.isArray(quote?.askLevels)&&quote.askLevels.length
    ?quote.askLevels:[{price:Number(quote?.bestAsk),size:Number(quote?.askSize)}];
  let remaining=shares,filledShares=0,notional=0,fees=0;
  for(const level of askLevels){
    const price=Number(level.price),size=Number(level.size);
    if(!Number.isFinite(price)||price<=0||price>=1||!Number.isFinite(size)||size<=0)continue;
    const filled=Math.min(remaining,size);
    notional+=filled*price;
    fees+=takerFeeFor(market,price,filled);
    filledShares+=filled;
    remaining-=filled;
    if(remaining<=1e-9)break;
  }
  return {filledShares,remainingShares:Math.max(0,remaining),notional,fees,
    averagePrice:filledShares?notional/filledShares:null};
}
function takerFeeFor(m,price,qty){
  if(m?.feesEnabled===false)return 0;
  const rate=Number(m?.feeSchedule?.rate??m?.takerFeeRate??cfg.CRYPTO_TAKER_FEE_RATE);
  const exponent=Number(m?.feeSchedule?.exponent??1);
  return Number.isFinite(rate)&&Number.isFinite(exponent)&&price>0&&price<1&&qty>0
    ?rate*Math.pow(price*(1-price),exponent)*qty:0;
}
function makerRebateFor(m,price,qty){
  const feeEquivalent=takerFeeFor(m,price,qty);
  return {feeEquivalent,estimate:feeEquivalent*cfg.CRYPTO_MAKER_REBATE_RATE};
}
function feeContext(m){
  return {feesEnabled:m?.feesEnabled,feeSchedule:m?.feeSchedule?{...m.feeSchedule}:undefined,
    takerFeeRate:m?.takerFeeRate};
}
function takeProfitHit(q,now=Date.now(),target){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid>=target}
function clobQuoteWinner(up,down){
  const upPrices=clobQuotePrices(up),downPrices=clobQuotePrices(down);
  const upHigh=upPrices.some(x=>x>=.98),downHigh=downPrices.some(x=>x>=.98);
  if(upHigh!==downHigh)return upHigh?'UP':'DOWN';
  const upLow=upPrices.some(x=>x<=.02),downLow=downPrices.some(x=>x<=.02);
  if(upLow!==downLow)return upLow?'DOWN':'UP';
  const u=clobQuoteValue(up),d=clobQuoteValue(down);
  if(u==null||d==null)return null;
  return u>=d?'UP':'DOWN';
}
class WickBot{
  constructor({timeframe='5m',windowMs=cfg.WINDOW_MS_5M,capital=cfg.DEMO_CAPITAL,
    strategyId='trigger-5m',strategyName='4-minute resting-limit strategy',rules={}}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.strategyId=strategyId;this.strategyName=strategyName;
    this.rules={entryWindowStartMs:cfg.ENTRY_WINDOW_START_MS,
      entryTriggerPriceMin:cfg.ENTRY_TRIGGER_PRICE_MIN,
      entryTriggerPriceMax:cfg.ENTRY_TRIGGER_PRICE_MAX,
      entryRungs:cfg.ENTRY_LIMIT_RUNGS,sharesPerSide:cfg.SHARES_PER_SIDE,
      takeProfitInitialPrice:cfg.TAKE_PROFIT_INITIAL_PRICE,
      takeProfitAfterOppositeHit:cfg.TAKE_PROFIT_AFTER_OPPOSITE_HIT,
      takeProfitPayout:cfg.TAKE_PROFIT_099_PAYOUT,takeProfitDelayMs:0,
      prebuyScanLeadMs:0,prebuySignalLeadMs:0,prebuyOrderLeadMs:0,...rules};
    this.startedAt=Date.now();
    this.positions=[];this.events=[];this.status='starting';this.completedWindows=new Map();
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.totalOrderAttempts=0;
    this.windowOrders=[];this.orderWindowStart=null;this.running=false;
    this.entryTriggerLatched=false;this.entryTriggerAt=null;this.entryTriggerSide=null;
    this.entryTriggerCandle=null;this.entryTriggerPrice=null;
    this.entryTriggerReason=null;this.entryPairPlaced=false;
    this.resolutionAttempts=new Map();
    this.quoteWindowStart=null;this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
    this.closeQuotes=null;
  }
  log(event,data={}){const e={ts:Date.now(),timeframe:this.timeframe,event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  captureQuotePair(now=Date.now(),source=this.liveQuotes,overrides={}){
    const numberOrNull=value=>value==null||value===''||!Number.isFinite(Number(value))?null:Number(value);
    return Object.fromEntries(['UP','DOWN'].map(side=>{
      const quote=overrides[side]||source?.[side]||{};
      const updatedAt=numberOrNull(quote.updatedAt);
      return [side,{
        status:quote.status||(quote.bestBid!=null||quote.bestAsk!=null?'LIVE':'MISSING'),
        bestBid:numberOrNull(quote.bestBid),bidSize:numberOrNull(quote.bidSize),
        bestAsk:numberOrNull(quote.bestAsk),askSize:numberOrNull(quote.askSize),
        mid:numberOrNull(quote.mid),updatedAt,
        ageMs:updatedAt==null?null:Math.max(0,now-updatedAt),
        stale:quote.stale===true||(updatedAt!=null&&now-updatedAt>5000),
      }];
    }));
  }
  captureExitQuotes(p,now,ownBid,hasBid=true){
    const source=p.closeQuotes||this.liveQuotes;
    const ownQuote={...(source?.[p.side]||{}),bestBid:hasBid?ownBid:null,updatedAt:now,
      status:hasBid?'LIVE':'MISSING'};
    p.exitQuotes=this.captureQuotePair(now,source,{[p.side]:ownQuote});
    p.exitQuoteAt=now;
  }
  async tick(){
    try{
      const now=Date.now(),currentStart=Math.floor(now/this.windowMs)*this.windowMs;
      const start=this.getWindowStartToScan(now,currentStart);
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
        this.closeQuotes=null;
      }
      await this.closePreviousWindows(currentStart,now);
       await this.resolvePendingPositions(now);
      if(!this.market||this.market.start!==start||now-this.lastMarketAt>cfg.MARKET_REFRESH_MS){
        this.market=await md.getBtcMarket(start,this.windowMs);this.lastMarketAt=now;
        if(!this.market){
          this.status='waiting_for_market';this.lastScanAt=now;
          if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{status:this.status,windowStart:start})}
          return;
        }
      }
      await this.refreshLiveQuotes(now);
      if(this.orderWindowStart!==start)this.openStrategyWindow(start,now);
      this.processPairedEntry(now,currentStart);
      const activatedTakeProfits=this.activateDeferredTakeProfits(now);
      if(activatedTakeProfits)this.processPendingTakeProfitOrders(now);
      if(now>=currentStart+this.windowMs-3000&&now<currentStart+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===currentStart&&p.status==='OPEN')p.closeQuotes=this.closeQuotes;
      }
      this.lastScanAt=now;this.error=null;
      const hasOpen=this.positions.some(p=>p.windowStart===this.market?.start&&p.status==='OPEN');
       this.status=this.completedWindows.has(start)?'window_complete':hasOpen?'position_open':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
  }
  getWindowStartToScan(_now,currentStart){return currentStart}
  async closePreviousWindows(currentStart,now=Date.now()){
    const previousOrders=this.orders.filter(order=>['PENDING','LIVE','MARKET_PENDING','PARTIALLY_FILLED'].includes(order.status)&&
      Number(order.windowStart)+this.windowMs<=currentStart);
    const open=this.positions.filter(p=>p.status==='OPEN'&&Number(p.windowStart)+this.windowMs<=currentStart);
    if(!previousOrders.length&&!open.length)return 0;
    for(const order of previousOrders){
      order.status=order.action==='SELL'?'EXPIRED_WINDOW_END':'CANCELLED_WINDOW_END';
      order.expiredAt=now;order.remainingShares=0;
    }
    const previousStarts=new Set([
      ...previousOrders.map(order=>order.windowStart),
      ...open.map(p=>p.windowStart),
    ]);
    for(const windowStart of previousStarts){
      if(Number.isFinite(Number(windowStart))&&!this.completedWindows.has(windowStart)){
        this.completedWindows.set(windowStart,{completedAt:now,
          reason:open.some(p=>p.windowStart===windowStart)?'PENDING_POLYMARKET_RESOLUTION':'WINDOW_END'});
      }
    }
    for(const p of open){
      p.status='PENDING_RESOLUTION';
      p.pendingResolutionSince=now;
      p.markStatus='PENDING_RESOLUTION';
      p.markValue=null;
      p.unrealizedPnl=null;
      this.log('PAPER_POSITION_AWAITING_POLYMARKET_RESOLUTION',{
        id:p.id,windowStart:p.windowStart,side:p.side,shares:p.shares,marketId:p.marketId,
        strategyOutcome:p.strategyOutcome});
    }
    for(const windowStart of previousStarts){
      this.log('PAPER_WINDOW_ROLLED_OVER',{windowStart,currentStart,closedPositions:open.filter(p=>p.windowStart===windowStart).length,
        cancelledOrders:previousOrders.filter(order=>order.windowStart===windowStart&&order.action==='BUY').length});
    }
    return open.length;
  }
  async resolvePendingPositions(now=Date.now()){
    const due=this.positions.filter(p=>p.status==='PENDING_RESOLUTION'&&p.marketId&&
      now-(this.resolutionAttempts.get(p.marketId)||0)>=cfg.RESOLUTION_POLL_MS);
    const marketIds=[...new Set(due.map(p=>p.marketId))];
    for(const marketId of marketIds){
      this.resolutionAttempts.set(marketId,now);
      try{
        const market=await md.getMarket(marketId);
        const winner=md.resolvedWinner(market);
        if(!winner)continue;
        for(const p of due.filter(item=>item.marketId===marketId)){
          if(p.status!=='PENDING_RESOLUTION')continue;
          this.finalizeResolution(p,winner,now);
        }
      }catch(error){
        const message=error?.message||'Could not fetch market resolution';
        if(!this.lastResolutionError||this.lastResolutionError!==message||
           now-(this.lastResolutionErrorAt||0)>=30000){
          this.lastResolutionError=message;this.lastResolutionErrorAt=now;
          this.log('POLYMARKET_RESOLUTION_CHECK_ERROR',{marketId,note:message});
        }
      }
    }
  }
  openStrategyWindow(start,now){
    this.orderWindowStart=start;
    this.windowOrders=[];
    this.entryTriggerLatched=false;
    this.entryTriggerAt=null;
    this.entryTriggerSide=null;
    this.entryTriggerCandle=null;
    this.entryTriggerPrice=null;
    this.entryTriggerReason=null;
    this.entryPairPlaced=false;
    this.entryAttemptMissed=false;
    this.log('PAPER_STRATEGY_WINDOW_STARTED',{windowStart:start,timeframe:this.timeframe,
      strategyId:this.strategyId,strategyName:this.strategyName,windowMs:this.windowMs,
      entryWindowStartMs:this.rules.entryWindowStartMs,
      triggerPriceMin:this.rules.entryTriggerPriceMin,
      triggerPriceMax:this.rules.entryTriggerPriceMax,
      entryRungs:this.rules.entryRungs||null,
      sharesPerSide:this.rules.sharesPerSide,prebuyOrderLeadMs:this.rules.prebuyOrderLeadMs||null});
  }
  processPairedEntry(now,_currentStart){
    if(this.rules.entryRungs?.length)return this.processLimitEntryOrders(now);
    return false;
  }
  processLimitEntryOrders(now){
    const start=this.orderWindowStart;
    if(!this.market||this.market.start!==start||this.completedWindows.has(start))return false;
    const elapsed=now-start;
    if(elapsed<this.rules.entryWindowStartMs||elapsed>=this.windowMs)return false;
    if(!this.entryPairPlaced){
      const triggeringSide=['UP','DOWN'].find(side=>{
        const quote=this.liveQuotes[side];
        const price=Number(quote?.bestAsk);
        return quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&
          now-quote.updatedAt<=5000&&Number.isFinite(price)&&
          price>this.rules.entryTriggerPriceMin&&price<this.rules.entryTriggerPriceMax;
      });
      if(!triggeringSide)return false;
      const triggerPrice=Number(this.liveQuotes[triggeringSide].bestAsk);
      this.entryPairPlaced=true;
      this.entryTriggerLatched=true;
      this.entryTriggerAt=now;
      this.entryTriggerSide=triggeringSide;
      this.entryTriggerPrice=triggerPrice;
      this.entryTriggerReason=`${triggeringSide} best ask ${usdPrice(triggerPrice)} entered the trigger band; placed all four resting limit buys.`;
      this.totalOrderAttempts+=2*this.rules.entryRungs.length;
      for(const side of ['UP','DOWN']){
        for(const rung of this.rules.entryRungs)this.placeLimitEntryOrder(side,rung,now,start);
      }
      this.log('PAPER_TRIGGER_PRICE_BAND_MATCHED',{strategyId:this.strategyId,
        windowStart:start,triggerSide:triggeringSide,triggerPrice,
        triggerPriceMin:this.rules.entryTriggerPriceMin,
        triggerPriceMax:this.rules.entryTriggerPriceMax});
      this.log('PAPER_LIMIT_ENTRY_LADDER_PLACED',{strategyId:this.strategyId,
        windowStart:start,orderCount:2*this.rules.entryRungs.length,
        sharesPerOrder:this.rules.sharesPerSide,rungs:this.rules.entryRungs,
        triggerSide:triggeringSide,triggerPrice});
    }
    return this.processPendingLimitBuyOrders(now);
  }
  placeLimitEntryOrder(side,rung,now,start){
    const price=Number(rung.limitPrice),takeProfitPrice=Number(rung.takeProfitPrice);
    const id=`${this.strategyId}-${this.timeframe}-${start}-${side.toLowerCase()}-entry-${rung.id}`;
    const order={id,timeframe:this.timeframe,windowStart:start,side,action:'BUY',kind:'ENTRY',
      strategyId:this.strategyId,tokenId:this.market.tokens?.[side]||null,
      orderType:'LIMIT',entryMode:'RESTING_LIMIT_BUY',entryType:'LIMIT_MAKER_BUY',
      limitPrice:price,requestedShares:this.rules.sharesPerSide,shares:this.rules.sharesPerSide,
      filledShares:0,remainingShares:this.rules.sharesPerSide,takeProfitPrice,
      rungId:rung.id,rungPrice:price,createdAt:now,submittedAt:now,
      expiresAt:start+this.windowMs,status:'PENDING',fee:0,estimatedMakerRebate:0};
    this.orders.unshift(order);this.windowOrders.unshift(order);
    this.log('PAPER_LIMIT_BUY_ORDER_PLACED',{id,side,limitPrice:price,
      takeProfitPrice,shares:order.shares,expiresAt:order.expiresAt});
    return order;
  }
  processPendingLimitBuyOrders(now){
    const fresh=quote=>quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&
      now-quote.updatedAt<=5000;
    let anyFilled=false;
    for(const side of ['UP','DOWN']){
      const quote=this.liveQuotes[side];
      if(!fresh(quote))continue;
      const available=(Array.isArray(quote.askLevels)&&quote.askLevels.length
        ?quote.askLevels:[{price:Number(quote.bestAsk),size:Number(quote.askSize)}])
        .map(level=>({price:Number(level.price),size:Number(level.size)}))
        .filter(level=>Number.isFinite(level.price)&&level.price>0&&level.price<1&&
          Number.isFinite(level.size)&&level.size>0).sort((a,b)=>a.price-b.price);
      const pending=this.orders.filter(order=>order.action==='BUY'&&order.side===side&&
        order.windowStart===this.orderWindowStart&&order.status==='PENDING')
        .sort((a,b)=>b.limitPrice-a.limitPrice);
      for(const order of pending){
        if(now>=order.expiresAt){
          order.status='CANCELLED_WINDOW_END';order.remainingShares=0;order.expiredAt=now;
          continue;
        }
        let availableShares=0;
        for(const level of available)if(level.price<=order.limitPrice)availableShares+=level.size;
        const requestedFill=Math.min(order.remainingShares,availableShares);
        if(requestedFill<=0)continue;
        const affordableFill=Math.min(requestedFill,this.cash/order.limitPrice);
        if(affordableFill<=0){
          order.status='REJECTED_INSUFFICIENT_CASH';order.remainingShares=0;
          order.reason='The paper balance cannot fund this limit-order fill.';
          this.log('PAPER_LIMIT_BUY_REJECTED',{id:order.id,side,limitPrice:order.limitPrice,
            availableCash:this.cash,reason:order.reason});
          continue;
        }
        let remainingToConsume=affordableFill;
        for(const level of available){
          if(level.price>order.limitPrice||remainingToConsume<=1e-9)continue;
          const consumed=Math.min(level.size,remainingToConsume);
          level.size-=consumed;remainingToConsume-=consumed;
        }
        this.fillLimitBuyOrder(order,Number(affordableFill.toFixed(6)),now);
        anyFilled=true;
      }
    }
    return anyFilled;
  }
  fillLimitBuyOrder(order,filledShares,now){
    const price=order.limitPrice,cost=Number((price*filledShares).toFixed(6));
    const rebate=makerRebateFor(this.market,price,filledShares);
    const id=`${order.id}-fill`;
    const takeProfitOrderId=`${id}-tp`;
    const position={id,timeframe:this.timeframe,windowMs:this.windowMs,
      windowStart:order.windowStart,marketId:this.market.id,slug:this.market.slug,
      title:this.market.title,side:order.side,tokenId:order.tokenId,entryKey:order.id,
      entryLabel:`limit buy at ${usdPrice(price)} · ${filledShares} shares`,
      entryMode:order.entryMode,entryType:order.entryType,phase:'limit-rung',
      strategyId:this.strategyId,strategyName:this.strategyName,rungId:order.rungId,
      takeProfitThreshold:order.takeProfitPrice,takeProfitPrice:order.takeProfitPrice,
      takeProfitOrderId,orderType:'LIMIT',fillModel:'PAPER_LIMIT_PRICE_TOUCH',
      shares:filledShares,requestedShares:order.requestedShares,initialShares:filledShares,
      avgEntry:price,fillPrice:price,cost,totalCost:cost,fees:0,exitFees:0,
      estimatedMakerRebate:rebate.estimate,status:'OPEN',submittedAt:order.submittedAt,
      openedAt:now,filledAt:now,visibleAskSize:this.liveQuotes[order.side].askSize,
      simulatedShares:filledShares,entryQuotes:this.captureQuotePair(now),
      entryQuoteAt:now,feeContext:feeContext(this.market)};
    const takeProfitOrder=this.buildTakeProfitOrder(position,order.takeProfitPrice,now);
    order.status='FILLED';order.filledAt=now;order.positionId=id;order.positionIds=[id];
    order.filledShares=filledShares;order.remainingShares=0;
    order.cancelledRemainderShares=Number((order.requestedShares-filledShares).toFixed(6));
    order.fillPrice=price;order.averagePrice=price;order.cost=cost;order.fee=0;
    order.estimatedMakerRebate=rebate.estimate;order.takeProfitOrderId=takeProfitOrderId;
    this.cash-=cost;
    this.positions.unshift(position);
    this.orders.unshift(takeProfitOrder);this.windowOrders.unshift(takeProfitOrder);
    if(this.orders.length>1000)this.orders.length=1000;
    this.log('PAPER_LIMIT_BUY_FILLED',{id:order.id,positionId:id,side:order.side,
      requestedShares:order.requestedShares,filledShares,limitPrice:price,cost,
      cancelledRemainderShares:order.cancelledRemainderShares,
      takeProfitPrice:order.takeProfitPrice,estimatedMakerRebate:rebate.estimate});
    return position;
  }
  placeMarketBuy(side,now,start,{entryMode='PAIRED_MARKET_BUY',
    entryType='TRIGGERED_PAIRED_TAKER_BUY',idSuffix='paired-entry',
    entryLabel='triggered market buy'}={}){
    const shares=this.rules.sharesPerSide;
    const id=`${this.strategyId}-${this.timeframe}-${start}-${side.toLowerCase()}-${idSuffix}`;
    const quote=this.liveQuotes[side];
    const order={id,timeframe:this.timeframe,windowStart:start,side,
      action:'BUY',kind:'ENTRY',tokenId:this.market.tokens?.[side]||null,
      orderType:'MARKET',entryMode,entryType,requestedShares:shares,shares,
      remainingShares:0,createdAt:now,submittedAt:now,status:'SUBMITTED',
      takeProfitPrice:this.rules.takeProfitInitialPrice,fee:0,strategyId:this.strategyId};
    const fill=takeAsks(quote,shares,this.market);
    if(fill.filledShares<=0){
      order.status='NO_LIQUIDITY';
      order.reason=`No ask-side liquidity was available for the ${side} market buy.`;
      this.orders.unshift(order);this.windowOrders.unshift(order);
      this.log('PAPER_MARKET_BUY_UNFILLED',{id,side,shares,reason:order.reason});
      return false;
    }
    const cost=Number(fill.notional.toFixed(6));
    const fees=Number(fill.fees.toFixed(6));
    const totalCost=Number((cost+fees).toFixed(6));
    if(totalCost>this.cash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';
      order.reason=`The paper cash balance was insufficient for the ${side} market buy and fees.`;
      this.orders.unshift(order);this.windowOrders.unshift(order);
      this.log('PAPER_MARKET_BUY_REJECTED',{id,side,shares,
        totalCost,availableCash:this.cash,reason:order.reason});
      return false;
    }
    const filledShares=Number(fill.filledShares.toFixed(6));
    const fillPrice=Number(fill.averagePrice.toFixed(6));
    const takeProfitOrderId=`${id}-tp`;
    const position={id,timeframe:this.timeframe,windowMs:this.windowMs,windowStart:start,
      marketId:this.market.id,slug:this.market.slug,title:this.market.title,side,
      tokenId:this.market.tokens[side],entryKey:id,
      entryLabel:`${entryLabel} · ${filledShares} shares`,
      entryMode:order.entryMode,entryType:order.entryType,phase:'signal',
      strategyId:this.strategyId,strategyName:this.strategyName,
      takeProfitThreshold:this.rules.takeProfitInitialPrice,
      takeProfitPrice:this.rules.takeProfitInitialPrice,takeProfitOrderId,
      takeProfitPendingAt:start+this.rules.takeProfitDelayMs,
      orderType:'MARKET',fillModel:'PAPER_TAKER_ASK_DEPTH',
      shares:filledShares,requestedShares:shares,initialShares:filledShares,
      avgEntry:fillPrice,fillPrice,cost,totalCost,fees,exitFees:0,
      estimatedMakerRebate:0,status:'OPEN',submittedAt:now,openedAt:now,filledAt:now,
      visibleAskSize:quote.askSize,simulatedShares:filledShares,
      entryQuotes:this.captureQuotePair(now),entryQuoteAt:now,feeContext:feeContext(this.market)};
    const takeProfitOrder=this.rules.takeProfitDelayMs>0?null:
      this.buildTakeProfitOrder(position,this.rules.takeProfitInitialPrice,now);
    order.status=fill.remainingShares<=1e-9?'FILLED':'PARTIALLY_FILLED';
    order.filledAt=now;order.positionId=id;order.fillPrice=fillPrice;
    order.filledShares=filledShares;order.fee=fees;order.cost=cost;
    order.totalCost=totalCost;order.averagePrice=fillPrice;
    order.cancelledRemainderShares=fill.remainingShares;
    order.takeProfitOrderId=takeProfitOrderId;
    this.cash-=totalCost;
    this.positions.unshift(position);
    this.orders.unshift(order);
    this.windowOrders.unshift(order);
    if(takeProfitOrder){
      this.orders.unshift(takeProfitOrder);
      this.windowOrders.unshift(takeProfitOrder);
    }
    if(this.orders.length>1000)this.orders.length=1000;
    this.log('PAPER_MARKET_BUY_FILLED',{id,side,shares,filledShares,
      averagePrice:fillPrice,notional:cost,fees,totalCost,
      takeProfitPrice:this.rules.takeProfitInitialPrice,
      canceledRemainderShares:fill.remainingShares});
    return true;
  }
  buildTakeProfitOrder(position,price,now){
    position.takeProfitOrderId=`${position.id}-tp`;
    position.takeProfitPrice=price;
    position.takeProfitThreshold=price;
    return {id:position.takeProfitOrderId,timeframe:this.timeframe,
      strategyId:this.strategyId,windowStart:position.windowStart,
      side:position.side,action:'SELL',kind:'TAKE_PROFIT',tokenId:position.tokenId,
      positionId:position.id,parentOrderId:position.id,orderType:'LIMIT',
      entryType:'LIMIT_TAKE_PROFIT',limitPrice:price,initialLimitPrice:price,
      shares:position.shares,remainingShares:position.shares,
      status:'PENDING',createdAt:now,submittedAt:now,
      expiresAt:position.windowStart+this.windowMs,fee:0,estimatedMakerRebate:0,
      fillModel:'PAPER_RESTING_LIMIT_BID_AT_OR_ABOVE_TARGET'};
  }
  activateDeferredTakeProfits(now){
    let activated=false;
    for(const position of this.positions){
      if(position.strategyId!==this.strategyId||position.status!=='OPEN'||
         position.takeProfitOrderId&&this.orders.some(order=>order.id===position.takeProfitOrderId)||
         !Number.isFinite(position.takeProfitPendingAt)||now<position.takeProfitPendingAt)continue;
      const order=this.buildTakeProfitOrder(position,this.rules.takeProfitInitialPrice,now);
      this.orders.unshift(order);this.windowOrders.unshift(order);
      if(this.orders.length>1000)this.orders.length=1000;
      position.takeProfitActivatedAt=now;
      activated=true;
      this.log('PAPER_TAKE_PROFIT_LIMIT_ACTIVATED',{strategyId:this.strategyId,
        positionId:position.id,side:position.side,limitPrice:order.limitPrice,
        scheduledAt:position.takeProfitPendingAt,activatedAt:now});
    }
    return activated;
  }
  raiseOppositeTakeProfits(position,now){
    for(const order of this.orders){
      if(order.action!=='SELL'||order.status!=='PENDING'||
         order.windowStart!==position.windowStart||order.side===position.side||
         order.limitPrice>=this.rules.takeProfitAfterOppositeHit)continue;
      const opposite=this.positions.find(item=>item.id===order.positionId&&item.status==='OPEN');
      if(!opposite)continue;
      const previousPrice=order.limitPrice;
      order.limitPrice=this.rules.takeProfitAfterOppositeHit;
      order.updatedAt=now;
      order.priceChangedReason='opposite_side_take_profit_filled';
      opposite.takeProfitPrice=this.rules.takeProfitAfterOppositeHit;
      opposite.takeProfitThreshold=this.rules.takeProfitAfterOppositeHit;
      this.log('PAPER_OPPOSITE_TAKE_PROFIT_RAISED',{positionId:opposite.id,
        from:previousPrice,to:order.limitPrice,triggeredByPositionId:position.id});
    }
  }
  recordStrategyOutcome(position,outcome,now=Date.now(),reason=outcome){
    if(position.strategyOutcomeApplied)return;
    if(!['WIN','LOSS','BREAK_EVEN'].includes(outcome))return;
    position.strategyOutcomeApplied=true;
    position.strategyOutcome=outcome;
    position.strategyOutcomeAt=now;
    position.strategyOutcomeReason=reason;
    this.log('PAPER_POSITION_OUTCOME_RECORDED',{positionId:position.id,outcome,reason});
  }
  processPendingTakeProfitOrders(now){
    for(const order of this.orders){
      if(order.status!=='PENDING'||order.action!=='SELL')continue;
      const position=this.positions.find(item=>item.id===order.positionId);
      if(!position||position.status!=='OPEN'){
        order.status='CANCELLED_POSITION_CLOSED';order.remainingShares=0;order.cancelledAt=now;
        continue;
      }
      if(now>=order.expiresAt){
        order.status='EXPIRED_WINDOW_END';order.remainingShares=0;order.expiredAt=now;
        continue;
      }
      const quote=this.liveQuotes[order.side];
      if(!takeProfitHit(quote,now,order.limitPrice))continue;
      const bid=Number(quote.bestBid);
      const fillPrice=order.limitPrice;
      order.status='FILLED';order.filledAt=now;order.fillPrice=fillPrice;
      order.remainingShares=0;
      if(this.finalizePosition(position,'TAKE_PROFIT_LIMIT',bid,now,order)){
        this.raiseOppositeTakeProfits(position,now);
      }
    }
  }
  async refreshLiveQuotes(now){
    if(!this.market)return;
    const sides=['UP','DOWN'];
    const results=await Promise.allSettled(sides.map(side=>md.getBook(this.market.tokens[side])));
    sides.forEach((side,i)=>{
      const result=results[i];
      if(result.status==='fulfilled')this.liveQuotes[side]=quoteFromBook(result.value,now);
      else{
        const previous=this.liveQuotes[side]||{};
        const stale=previous.updatedAt?now-previous.updatedAt>10000:true;
        this.liveQuotes[side]={...previous,status:previous.updatedAt?(stale?'STALE':'LIVE'):'ERROR',stale,
          attemptedAt:now,error:result.reason?.message||'Order book unavailable'};
      }
    });
    const open=this.positions.filter(p=>p.status==='OPEN');
    for(const p of open){
      if(p.windowStart===this.market.start){
        const q=this.liveQuotes[p.side];
        p.markBid=q?.bestBid??null;p.markUpdatedAt=q?.updatedAt||now;p.markStatus=q?.bestBid!=null?'LIVE':'MISSING';
      }
    }
    this.processPendingTakeProfitOrders(now);
  }
  finalizePosition(p,reason,triggerQuote,settledAt,takeProfitOrder){
    if(p.status!=='OPEN'||reason!=='TAKE_PROFIT_LIMIT'||!takeProfitOrder)return false;
    const exitPrice=takeProfitOrder.limitPrice;
    const maker=makerRebateFor(p.feeContext,exitPrice,p.shares);
    p.payout=exitPrice>=this.rules.takeProfitAfterOppositeHit
      ?this.rules.takeProfitPayout:exitPrice;
    p.proceeds=p.shares*p.payout;
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost-p.exitFees;
    p.estimatedMakerRebate=(p.estimatedMakerRebate||0)+maker.estimate;
    p.status='SETTLED_EXIT';
    p.settledAt=settledAt;
    p.settlementBasis='TAKE_PROFIT_LIMIT';
    p.exitReason='TAKE_PROFIT_LIMIT';
    p.tpTriggerQuote=triggerQuote;
    p.exitBid=exitPrice;
    p.exitType='LIMIT';
    this.captureExitQuotes(p,settledAt,p.exitBid,p.exitBid!=null);
    this.cash+=p.proceeds-p.exitFees;
    takeProfitOrder.estimatedMakerRebate=maker.estimate;
    this.log('PAPER_TP_LIMIT_FILLED',{id:p.id,status:p.status,pnl:p.realizedPnl,side:p.side,
      shares:p.shares,limitPrice:takeProfitOrder.limitPrice,fillPrice:exitPrice,
      payoutPerShare:p.payout,proceeds:p.proceeds,exitFees:p.exitFees,
      triggerQuote,estimatedMakerRebate:maker.estimate});
    const outcome=p.realizedPnl>0?'WIN':p.realizedPnl<0?'LOSS':'BREAK_EVEN';
    this.recordStrategyOutcome(p,outcome,settledAt,`TAKE_PROFIT_LIMIT_FILLED_AT_${exitPrice}`);
    return true;
  }
  finalizeResolution(p,winner,now=Date.now()){
    if(p.status!=='PENDING_RESOLUTION')return false;
    const won=p.side===winner;
    p.payout=won?1:0;
    p.proceeds=p.shares*p.payout;
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost;
    p.status='SETTLED_EXIT';
    p.settledAt=now;
    p.settlementBasis='POLYMARKET_RESOLUTION';
    p.exitReason='POLYMARKET_RESOLUTION';
    p.exitType='SETTLEMENT';
    p.exitBid=null;
    p.resolutionWinner=winner;
    p.markValue=0;
    p.unrealizedPnl=0;
    p.markStatus='CLOSED';
    this.cash+=p.proceeds;
    this.completedWindows.set(p.windowStart,{completedAt:now,reason:'POLYMARKET_RESOLUTION',winner});
    this.log(won?'PAPER_OFFICIAL_WIN':'PAPER_OFFICIAL_LOSS',{
      id:p.id,side:p.side,winner,shares:p.shares,payout:p.payout,proceeds:p.proceeds,
      pnl:p.realizedPnl,windowStart:p.windowStart});
    this.recordStrategyOutcome(p,won?'WIN':'LOSS',now,'POLYMARKET_RESOLUTION');
    return true;
  }
  snapshot(){
    const now=Date.now();
    const realizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
     const takerFees=this.positions.reduce((s,p)=>s+(p.fees||0)+(p.exitFees||0),0);
     const estimatedMakerRebate=this.positions.reduce((s,p)=>s+(p.estimatedMakerRebate||0),0);
    const exits=this.positions.filter(p=>p.status==='SETTLED_EXIT').length;
    const profitableExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&(Number(p.realizedPnl)||0)>0).length;
    const losingExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&(Number(p.realizedPnl)||0)<0).length;
    const breakEvenExits=exits-profitableExits-losingExits;
     const wins=profitableExits,losses=losingExits;
     const settledTrades=exits;
    const totalTrades=this.positions.filter(p=>p.status!=='CANCELLED_UNFILLED').length;
     const history=this.positions.filter(p=>p.status==='SETTLED_EXIT')
      .sort((a,b)=>(a.settledAt||0)-(b.settledAt||0));
      const strategyHistory=this.positions.filter(p=>['WIN','LOSS','BREAK_EVEN'].includes(p.strategyOutcome))
       .sort((a,b)=>(a.strategyOutcomeAt||a.windowStart||0)-(b.strategyOutcomeAt||b.windowStart||0));
    const equityCurve=[{ts:this.startedAt,equity:this.capital}];
     let curveEquity=this.capital,peak=this.capital,maxDrawdown=0;
      let maxConsecutiveLosses=0,maxConsecutiveWins=0,lossStreak=0,winStreak=0;
    for(const p of history){
      curveEquity+=Number(p.realizedPnl)||0;
      equityCurve.push({ts:p.settledAt||p.openedAt,equity:curveEquity});
      peak=Math.max(peak,curveEquity);maxDrawdown=Math.max(maxDrawdown,peak-curveEquity);
     }
     for(const p of strategyHistory){
        if(p.strategyOutcome==='LOSS'){
         lossStreak++;winStreak=0;
         maxConsecutiveLosses=Math.max(maxConsecutiveLosses,lossStreak);
        }else if(p.strategyOutcome==='WIN'){
         winStreak++;lossStreak=0;
         maxConsecutiveWins=Math.max(maxConsecutiveWins,winStreak);
        }else{
          winStreak=0;lossStreak=0;
       }
    }
    let unrealizedPnl=0,unpricedOpenPositions=0,markedValue=0;
    for(const p of this.positions){
       if(p.status==='PENDING_RESOLUTION'){
         p.markValue=null;p.unrealizedPnl=null;p.markStatus='PENDING_RESOLUTION';
         unpricedOpenPositions++;
         continue;
       }
       if(p.status!=='OPEN'){
        p.markValue=0;p.unrealizedPnl=0;p.markStatus='CLOSED';continue;
      }
      const mark=p.markBid==null?null:p.markBid*p.shares;p.markAgeMs=p.markUpdatedAt?Math.max(0,now-p.markUpdatedAt):null;p.markStatus=mark==null?'UNAVAILABLE':p.markAgeMs>15000?'STALE':'LIVE';const freshMark=mark!=null&&p.markAgeMs<=15000;p.markValue=freshMark?mark:null;p.unrealizedPnl=freshMark?mark-p.totalCost:null;if(!freshMark)unpricedOpenPositions++;else{markedValue+=mark;unrealizedPnl+=p.unrealizedPnl}
    }
    const inventory={UP:{shares:0,cost:0,averageCost:null,positions:0},DOWN:{shares:0,cost:0,averageCost:null,positions:0}};
      for(const p of this.positions){
         if(p.status!=='OPEN'||p.windowStart!==this.market?.start||!inventory[p.side])continue;
       const shares=Number(p.shares)||0;
       inventory[p.side].shares+=shares;
       inventory[p.side].cost+=Number(p.totalCost)||((Number(p.avgEntry)||0)*shares);
       inventory[p.side].positions++;
     }
     for(const side of ['UP','DOWN']){
       const sideInventory=inventory[side];
       sideInventory.averageCost=sideInventory.shares?sideInventory.cost/sideInventory.shares:null;
     }
          const elapsedMs=this.market?now-this.market.start:0;
          const isCandlePrebuy=this.rules.prebuyScanLeadMs>0;
          const currentEntryWindow=!!this.market&&(isCandlePrebuy
            ?elapsedMs>=-this.rules.prebuyScanLeadMs&&elapsedMs<0
            :elapsedMs>=this.rules.entryWindowStartMs&&elapsedMs<this.windowMs);
        const safeQuotes=this.captureQuotePair(now);
         const signalReason=this.entryTriggerReason||(this.entryPairPlaced
           ?isCandlePrebuy?'The indicated candle side was bought.':'Four fixed-price limit orders are working.'
           :this.entryAttemptMissed?'Pre-window entry was missed before the market opened.'
           :this.entryTriggerLatched?'Signal latched; waiting for the order time or a fresh quote.'
           :currentEntryWindow
             ?isCandlePrebuy?'Pre-buy phase active; waiting for the candle signal or market-open buy time.'
                :'Monitoring both best asks for the $0.32–$0.70 trigger band.'
             :isCandlePrebuy?'Waiting for the final 10 seconds before the next window.'
               :'Waiting until 4:00 into the 5-minute window.');
        return {now,mode:'DEMO ONLY',status:this.status,error:this.error,
             strategy:{id:this.strategyId,name:this.strategyName,timeframe:this.timeframe,
               market:'Polymarket BTC 5-minute UP/DOWN',
              capital:this.capital,execution:'PAPER ONLY',
              entries:{orderType:isCandlePrebuy?'MARKET':'LIMIT',
                   sideSelection:isCandlePrebuy
                     ?'Final 57-second BTC move versus the previous closed one-minute candle: higher UP; otherwise DOWN.'
                     :'Either side triggers both sides when its fresh best ask enters the price band.',
                  sharesPerSide:this.rules.sharesPerSide,
                   rungs:this.rules.entryRungs,
                  windowStartMs:this.rules.entryWindowStartMs,windowEndMs:this.windowMs,
                  triggerPriceMin:isCandlePrebuy?null:this.rules.entryTriggerPriceMin,
                  triggerPriceMax:isCandlePrebuy?null:this.rules.entryTriggerPriceMax,
                   prebuyScanSecondsBeforeWindow:this.rules.prebuyScanLeadMs/1000,
                   prebuySignalSecondsBeforeWindow:this.rules.prebuySignalLeadMs/1000,
                   prebuyOrderSecondsBeforeWindow:this.rules.prebuyOrderLeadMs/1000,
                  triggerPriceSource:isCandlePrebuy?'live BTC price versus previous closed one-minute candle close':'fresh UP/DOWN best ask',
                 triggerLatched:this.entryTriggerLatched,triggerAt:this.entryTriggerAt,
                  triggerSide:this.entryTriggerSide,triggerPrice:this.entryTriggerPrice,
                  pairPlaced:this.entryPairPlaced,
                  attemptMissed:this.entryAttemptMissed===true,
                  signal:{side:this.entryTriggerSide,reason:signalReason,
                    candle:this.entryTriggerCandle,ready:this.entryTriggerLatched}},
                exit:{orderType:'LIMIT',takeProfitDelayMs:this.rules.takeProfitDelayMs,
                  initialTakeProfitPrice:this.rules.takeProfitInitialPrice,
                  oppositeTakeProfitAfterFirstFill:this.rules.takeProfitAfterOppositeHit,
                  oppositeTakeProfitPayout:this.rules.takeProfitPayout,stopLoss:null,
                 windowEnd:'Expire take-profit orders; hold positions without a fill for official market resolution.'},
                 timing:isCandlePrebuy
                   ?'Compare BTC at 3 seconds before open with the previous closed 1-minute candle close; market-buy the indicated side 2 seconds before open.'
                   :'From 4:00, monitor every tick; when either side is above $0.32 and below $0.70, place both-side limit buys.',
                 sizing:isCandlePrebuy
                   ?`Market-buy ${this.rules.sharesPerSide} shares on the one-minute candle's indicated side.`
                   :`${this.rules.sharesPerSide} shares per side at each of the $0.20 and $0.10 limit rungs.`,
                 trigger:isCandlePrebuy
                   ?'At T−3s, compare BTC with the previous closed 1-minute candle close: higher is green/UP; equal or lower is red/DOWN. This represents the final 57 seconds.'
                   :'A fresh UP or DOWN best ask strictly inside $0.32–$0.70 latches the trigger; then place UP and DOWN limits at $0.20 and $0.10.',
                unfilled:isCandlePrebuy
                  ?'A buy requires a fresh ask-side book before window open; unfilled entries are skipped. Positions without TP fills by window end await official Polymarket resolution.'
                  :'Limit buys fill only against visible ask size at or below their fixed limit. Unfilled entries are canceled at window end; filled positions await TP or official resolution.',
                fees:isCandlePrebuy
                  ?'Taker fees are charged on market-buy fills; limit sells have no taker fee and may earn an estimated maker rebate.'
                  :'Maker limit buys and limit sells have no taker fee; estimated maker rebates are shown. Resolution payouts have no fee.',
              execution:'PAPER ONLY'},
         account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,estimatedMakerRebate,
          totalTrades,settledTrades,wins,losses,profitableExits,losingExits,breakEvenExits,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
           openPositions:this.positions.filter(p=>['OPEN','PENDING_RESOLUTION'].includes(p.status)).length,
          maxConsecutiveLosses,maxConsecutiveWins,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
          wins,losses,equityCurve},
       window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end,
         complete:this.completedWindows.has(this.market.start),completionReason:this.completedWindows.get(this.market.start)?.reason||null}:null,
       livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:safeQuotes.UP,DOWN:safeQuotes.DOWN},
         scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
             source:`Polymarket BTC ${this.timeframe} Gamma/CLOB order books`,
                marketResolution:'Positions without a take-profit fill wait for the official Polymarket market result.'},
       inventory,positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
          start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,
           strategyId:this.strategyId,strategyName:this.strategyName,
           note:`Paper-only BTC 5-minute strategy: ${this.strategyName}.`});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={quoteFromBook,takerFeeFor,makerRebateFor,takeProfitHit};
