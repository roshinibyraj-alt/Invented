'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');
const {feed:chainlinkFeed}=require('./chainlink-price-feed');
const {classifyRegime}=require('./regime-detector');
const candleStrategy=require('./candle-strategy');

function levels(xs){return (xs||[]).map(x=>({price:Number(x.price),size:Number(x.size)}))
  .filter(x=>Number.isFinite(x.price)&&x.size>0).sort((a,b)=>a.price-b.price)}
function usdPrice(x){return '$'+Number(x).toFixed(2)}
function quoteFromBook(book,updatedAt){
  const bids=levels(book.bids),asks=levels(book.asks);
  const bid=bids.sort((a,b)=>b.price-a.price)[0]||null;
  const ask=asks[0]||null;
  const bestBid=bid?.price??null,bestAsk=ask?.price??null;
  return {status:bid||ask?'LIVE':'MISSING',bestBid,bidSize:bid?.size??0,
    bestAsk,askSize:ask?.size??0,mid:bestBid!=null&&bestAsk!=null?(bestBid+bestAsk)/2:null,
    updatedAt,stale:false,error:null};
}
function simulateAtBestAsk(asks,qty,maxPrice,minPrice=cfg.MIN_ENTRY_ASK){
  const best=levels(asks).find(x=>x.price>=minPrice&&x.price<maxPrice);
  if(!best)return null;
  return {shares:qty,cost:qty*best.price,avg:best.price,visibleDepth:best.size,
    simulatedShares:Math.max(0,qty-best.size)};
}
function makerRebateFor(m,price,qty){
  if(m?.feesEnabled===false)return {feeEquivalent:0,estimate:0};
  const rate=Number(m?.feeSchedule?.rate??m?.takerFeeRate??cfg.CRYPTO_TAKER_FEE_RATE);
  const exponent=Number(m?.feeSchedule?.exponent??1);
  const feeEquivalent=Number.isFinite(rate)&&Number.isFinite(exponent)&&price>0&&price<1&&qty>0
    ?rate*Math.pow(price*(1-price),exponent)*qty:0;
  return {feeEquivalent,estimate:feeEquivalent*cfg.CRYPTO_MAKER_REBATE_RATE};
}
function clobWinner(up,down){
  if(!Number.isFinite(up)||!Number.isFinite(down))return null;
  return up>=.98?'UP':down>=.98?'DOWN':up>=down?'UP':'DOWN';
}
function clobQuotePrices(q){
  return [q?.mid,q?.bestBid,q?.bestAsk].filter(x=>x!=null&&x!=='').map(Number)
    .filter(x=>Number.isFinite(x)&&x>=0&&x<=1);
}
function clobQuoteValue(q){const prices=clobQuotePrices(q);return prices.length?Math.max(...prices):null}
function clobQuoteFloor(q){const prices=clobQuotePrices(q);return prices.length?Math.min(...prices):null}
function takeProfitHit(q,now=Date.now()){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid>=.99}
function stopLossHit(q,now=Date.now()){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid<=.01}
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
  constructor({timeframe='5m',windowMs=cfg.WINDOW_MS_5M,capital=cfg.DEMO_CAPITAL_5M,
    priceFeed=chainlinkFeed}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.priceFeed=priceFeed;
    this.marketRegime={state:'UNKNOWN',reason:'Waiting for fresh BTC price history'};
    this.startedAt=Date.now();
    this.positions=[];this.events=[];this.status='starting';this.completedWindows=new Map();
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.totalOrderAttempts=0;
    this.windowOrders=[];this.orderWindowStart=null;this.running=false;
    this.windowStrategySide=null;
    this.windowSignalSide=null;
    this.candleEvaluation={side:null,reason:'Waiting for closed-candle history'};
    this.candleOrdersPlaced=false;
    this.catchUpDecision={status:'waiting',eligible:false,executed:false,reason:'Waiting for the 2-minute rung check.'};
    this.recovery={shares:cfg.RECOVERY_BASE_SHARES,martingaleLevel:0,pendingWindowStart:null,
      activePositionId:null,lastResult:null,lastTriggerWindowStart:null};
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
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
        this.closeQuotes=null;
      }
      await this.closePreviousWindows(start,now);
      if(!this.market||this.market.start!==start||now-this.lastMarketAt>cfg.MARKET_REFRESH_MS){
        this.market=await md.getBtcMarket(start,this.windowMs);this.lastMarketAt=now;
        if(!this.market){
          this.status='waiting_for_market';this.lastScanAt=now;
          if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{status:this.status,windowStart:start})}
          return;
        }
      }
      await this.refreshLiveQuotes(now);
      this.updateMarketRegime(now);
      if(this.orderWindowStart!==start)this.openStrategyWindow(start,now);
       this.updateCandleContext();
       this.processCandleEntries(start,now);
      this.processRecoveryEntry(start,now);
      if(now>=start+this.windowMs-3000&&now<start+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===start&&p.status==='OPEN')p.closeQuotes=this.closeQuotes;
      }
      this.lastScanAt=now;this.error=null;
      const hasOpen=this.positions.some(p=>p.windowStart===start&&p.status==='OPEN');
      this.status=this.completedWindows.has(start)?'window_complete':hasOpen?'position_open':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
  }
  async closePreviousWindows(currentStart,now=Date.now()){
    const previousOrders=this.orders.filter(order=>['PENDING','LIVE','MARKET_PENDING'].includes(order.status)&&order.windowStart!==currentStart);
    const open=this.positions.filter(p=>p.status==='OPEN'&&p.windowStart!==currentStart);
    if(!previousOrders.length&&!open.length)return 0;
    for(const order of previousOrders){
        order.status='EXPIRED_WINDOW_ROLLOVER';order.expiredAt=now;order.remainingShares=0;
    }
    const previousStarts=new Set([
      ...previousOrders.map(order=>order.windowStart),
      ...open.map(p=>p.windowStart),
    ]);
    for(const windowStart of previousStarts){
      if(Number.isFinite(Number(windowStart))&&!this.completedWindows.has(windowStart)){
        this.completedWindows.set(windowStart,{completedAt:now,reason:'WINDOW_ROLLOVER'});
      }
    }
    const quoteCache=new Map();
    const readQuote=async p=>{
      if(p.markBid!=null&&Number.isFinite(Number(p.markBid))&&Number.isFinite(p.markUpdatedAt)&&now-p.markUpdatedAt<=5000){
        return {bestBid:Number(p.markBid),updatedAt:p.markUpdatedAt,status:'LIVE'};
      }
      if(!p.tokenId)return null;
      if(!quoteCache.has(p.tokenId)){
        quoteCache.set(p.tokenId,md.getBook(p.tokenId).then(book=>quoteFromBook(book,now)).catch(()=>null));
      }
      return quoteCache.get(p.tokenId);
    };
    const quoted=await Promise.all(open.map(async p=>[p,await readQuote(p)]));
    for(const [p,q] of quoted){
      if(p.status!=='OPEN')continue;
      if(takeProfitHit(q,now)){
        this.finalizePosition(p,true,'TAKE_PROFIT_BID',Number(q.bestBid));
      }else if(stopLossHit(q,now)){
        this.finalizePosition(p,false,'STOP_LOSS_BID',Number(q.bestBid));
      }else if(q?.bestBid!=null&&Number.isFinite(Number(q.bestBid))){
        p.markBid=Number(q.bestBid);p.markUpdatedAt=q.updatedAt||now;
        this.finalizeWindowLiquidation(p,Number(q.bestBid),'WINDOW_ROLLOVER_BID',now);
      }else{
        this.finalizeWindowLiquidation(p,0,'WINDOW_ROLLOVER_NO_BID',now);
      }
    }
    for(const windowStart of previousStarts){
      this.log('PAPER_WINDOW_ROLLED_OVER',{windowStart,currentStart,closedPositions:open.filter(p=>p.windowStart===windowStart).length,
        cancelledOrders:previousOrders.filter(order=>order.windowStart===windowStart).length});
    }
    return open.length;
  }
  updateMarketRegime(now=Date.now()){
    try{
      this.marketRegime=classifyRegime(this.priceFeed.getTicks(),now,{
        lookbackMs:cfg.CHOP_LOOKBACK_MS,sampleMs:cfg.CHOP_SAMPLE_MS,
        chopEfficiencyMax:cfg.CHOP_MIN_EFFICIENCY,minReversals:cfg.CHOP_MIN_REVERSALS,
        trendEfficiencyMin:cfg.TREND_MIN_EFFICIENCY,trendNetMoveMinPct:cfg.TREND_MIN_NET_MOVE_PCT,
      });
    }catch(error){
      this.marketRegime={state:'UNKNOWN',reason:error?.message||'BTC price feed unavailable'};
    }
    return this.marketRegime;
  }
  openStrategyWindow(start,now){
    this.orderWindowStart=start;
    this.lastEntryCheckpoint=0;
    this.windowOrders=[];
    this.windowStrategySide=null;
    this.windowSignalSide=null;
    this.candleOrdersPlaced=false;
    this.catchUpDecision={status:'waiting',eligible:false,executed:false,reason:'Waiting for the 2-minute rung check.'};
    this.candleEvaluation={side:null,reason:'Waiting for a complete previous candle'};
    this.log('PAPER_CANDLE_WINDOW_STARTED',{windowStart:start,timeframe:this.timeframe});
  }
  updateCandleContext(){
    try{
      this.minuteCandles=this.priceFeed.getMinuteCandles();
      this.candleFeedError=null;
    }catch(error){
      this.candleFeedError=error?.message||'BTC candle history is unavailable';
      if(!this.windowSignalSide)this.candleEvaluation={side:null,reason:this.candleFeedError};
    }
  }
  processCandleEntries(start,now){
    if(this.completedWindows.has(start)||this.orderWindowStart!==start||this.candleOrdersPlaced)return;
    const windowsByStart=new Map((this.priceFeed.getHistoricalCandles?.()||[])
      .filter(candle=>candle.end<=start).map(candle=>[candle.start,candle]));
    for(const candle of candleStrategy.aggregateCompleteCandles(this.minuteCandles||[],this.windowMs)
      .filter(candle=>candle.end<=start))windowsByStart.set(candle.start,candle);
    const windows=[...windowsByStart.values()].sort((a,b)=>a.start-b.start);
    const signal=candleStrategy.signalForPrevious(windows);
    this.candleEvaluation={...signal,ready:!!signal.previous};
    if(!signal.side){
      this.candleOrdersPlaced=false;
      this.windowSignalSide=null;
      this.windowStrategySide=null;
      return;
    }
    this.windowSignalSide=signal.side;
    this.windowStrategySide=signal.side;
    this.candleOrdersPlaced=true;
    const requiredCash=cfg.SIGNAL_LIMIT_RUNGS.reduce((sum,rung)=>sum+rung.price*rung.shares,0);
    const reserved=this.orders.reduce((sum,order)=>sum+
      (order.status==='PENDING'?(order.limitPrice||0)*(order.remainingShares||order.shares||0):0),0);
    if(requiredCash+reserved>this.cash+1e-9){
      this.log('PAPER_LADDER_REJECTED',{windowStart:start,side:signal.side,requiredCash,reserved,cash:this.cash,
        reason:'Insufficient paper cash to reserve both signal-side limits.'});
      return;
    }
    const tokenId=this.market.tokens[signal.side];
    const expiresAt=start+this.windowMs;
    for(const rung of cfg.SIGNAL_LIMIT_RUNGS){
      const id=`${this.timeframe}-${start}-${rung.price.toFixed(2)}`;
      const order={id,timeframe:this.timeframe,windowStart:start,side:signal.side,
        signalSide:signal.side,tokenId,orderType:'LIMIT',limitPrice:rung.price,rungPrice:rung.price,
        shares:rung.shares,remainingShares:rung.shares,status:'PENDING',
        entryMode:'SIGNALLED_SIDE',entryType:'SIGNAL_PATTERN_LIMIT',
        createdAt:now,submittedAt:now,quoteAtSubmission:this.liveQuotes[signal.side]?.updatedAt||0,
        expiresAt,pattern:signal.pattern,fee:0,
        estimatedMakerRebate:makerRebateFor(this.market,rung.price,rung.shares).estimate,
        fillModel:'PAPER_FRESH_ASK_AT_OR_BELOW_LIMIT'};
      this.windowOrders.push(order);
      this.orders.unshift(order);
      this.totalOrderAttempts++;
      this.log('PAPER_SIGNAL_LIMIT_ORDER_PLACED',{
        id,windowStart:start,signalSide:signal.side,side:signal.side,
        limitPrice:rung.price,shares:rung.shares,expiresAt,pattern:signal.pattern,
      });
    }
    if(this.orders.length>1000)this.orders.length=1000;
  }
  processRecoveryEntry(start,now){
    const recovery=this.recovery;
    if(recovery.pendingWindowStart==null||recovery.activePositionId)return false;
    if(start<recovery.pendingWindowStart)return false;
    if(start>recovery.pendingWindowStart)recovery.pendingWindowStart=start;
    if(!this.market||this.market.start!==start||!this.windowSignalSide)return false;
    const side=this.windowSignalSide==='UP'?'DOWN':'UP';
    const quote=this.liveQuotes[side],ask=Number(quote?.bestAsk);
    const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&
      now-quote.updatedAt<=5000&&Number.isFinite(ask)&&ask>0&&ask<1;
    if(!fresh)return false;
    const shares=recovery.shares,cost=ask*shares;
    const fee=makerRebateFor(this.market,ask,shares).feeEquivalent;
    if(cost+fee>this.cash+1e-9)return false;
    const id=`${this.timeframe}-${start}-recovery-${recovery.martingaleLevel}`;
    const order={id,timeframe:this.timeframe,windowStart:start,side,signalSide:this.windowSignalSide,
      tokenId:this.market.tokens[side],orderType:'MARKET',limitPrice:null,shares,remainingShares:0,
      status:'FILLED',entryMode:'RECOVERY_MARTINGALE',entryType:'NEXT_WINDOW_OPPOSITE_SIGNAL',
      createdAt:now,submittedAt:now,filledAt:now,fillPrice:ask,averageFillPrice:ask,fee,
      estimatedMakerRebate:0,martingaleLevel:recovery.martingaleLevel,
      reason:'Next-window market paper entry opposite the candle signal after a rung TP.'};
    const position={id,timeframe:this.timeframe,windowMs:this.windowMs,windowStart:start,
      marketId:this.market.id,slug:this.market.slug,title:this.market.title,side,
      tokenId:this.market.tokens[side],entryKey:id,entryLabel:`${side} recovery market buy · ${shares} shares`,
      entryMode:'RECOVERY_MARTINGALE',entryType:'NEXT_WINDOW_OPPOSITE_SIGNAL',orderType:'MARKET',
      martingaleLevel:recovery.martingaleLevel,signalSide:this.windowSignalSide,shares,initialShares:shares,
      avgEntry:ask,fillPrice:ask,cost,totalCost:cost+fee,fees:fee,estimatedMakerRebate:0,status:'OPEN',
      submittedAt:now,openedAt:now,filledAt:now,markBid:quote.bestBid,markUpdatedAt:quote.updatedAt,
      markStatus:'LIVE',entryQuotes:this.captureQuotePair(now),entryQuoteAt:now};
    order.positionId=id;
    this.orders.unshift(order);this.windowOrders.unshift(order);this.positions.unshift(position);
    this.cash-=cost+fee;this.totalOrderAttempts++;recovery.activePositionId=id;recovery.pendingWindowStart=null;
    this.log('PAPER_RECOVERY_MARKET_BUY',{id,side,signalSide:this.windowSignalSide,shares,price:ask,
      martingaleLevel:recovery.martingaleLevel});
    return true;
  }
  updateRecoveryAfterClose(p){
    if(p.entryMode==='RECOVERY_MARTINGALE'){
      const recovery=this.recovery;
      if(recovery.activePositionId!==p.id)return;
      recovery.activePositionId=null;
      if(Number(p.realizedPnl)>0){
        recovery.martingaleLevel=0;recovery.shares=cfg.RECOVERY_BASE_SHARES;
        recovery.pendingWindowStart=null;recovery.lastResult='WIN';
      }else if(Number(p.martingaleLevel)<cfg.RECOVERY_MAX_MARTINGALE_LEVEL){
        recovery.martingaleLevel=Number(p.martingaleLevel)+1;
        recovery.shares=cfg.RECOVERY_BASE_SHARES*Math.pow(2,recovery.martingaleLevel);
        recovery.pendingWindowStart=p.windowStart+this.windowMs;recovery.lastResult='LOSS';
      }else{
        recovery.martingaleLevel=0;recovery.shares=cfg.RECOVERY_BASE_SHARES;
        recovery.pendingWindowStart=null;recovery.lastResult='MAX_MARTINGALE_LOSS_RESET';
      }
      return;
    }
    const isRungTP=p.entryType==='SIGNAL_PATTERN_LIMIT'&&
      (Math.abs(Number(p.avgEntry)-0.30)<1e-9||Math.abs(Number(p.avgEntry)-0.20)<1e-9)&&
      (p.exitReason==='TAKE_PROFIT_BID'||p.exitReason==='TP_HIT_0_99');
    if(isRungTP&&this.recovery.lastTriggerWindowStart!==p.windowStart&&!this.recovery.activePositionId){
      this.recovery.lastTriggerWindowStart=p.windowStart;
      this.recovery.pendingWindowStart=p.windowStart+this.windowMs;
      this.log('PAPER_RECOVERY_ARMED',{triggerWindowStart:p.windowStart,nextWindowStart:this.recovery.pendingWindowStart,
        shares:this.recovery.shares});
    }
  }
  windowShares(start,side){
    return this.positions.filter(p=>p.status==='OPEN'&&p.windowStart===start&&p.side===side)
      .reduce((sum,p)=>sum+(Number(p.shares)||0),0);
  }
  attemptEntry(start,now,side,shares,checkpoint,id,entryMode='BASE'){
    if(this.completedWindows.has(start))return false;
    const quote=this.liveQuotes[side],ask=Number(quote?.bestAsk),bid=Number(quote?.bestBid),mid=Number(quote?.mid);
    const order={id,timeframe:this.timeframe,windowStart:start,side,checkpoint,
      secondsIntoWindow:checkpoint*cfg.ENTRY_CHECK_INTERVAL_MS/1000,
      entryMode,ask:Number.isFinite(ask)?ask:null,bid:Number.isFinite(bid)?bid:null,
      midpoint:Number.isFinite(mid)?mid:null,shares,orderType:'LIMIT',status:'SKIPPED',
      createdAt:now,entryType:entryMode==='CONTRARIAN'?'CONTRARIAN_BTC_DIRECTION':'MIDPOINT_OFFSET',
      quotePairAtSubmission:this.captureQuotePair(now)};
    this.totalOrderAttempts++;
    this.windowOrders.unshift(order);this.orders.unshift(order);
    if(this.orders.length>1000)this.orders.length=1000;
    const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
      &&now-quote.updatedAt<=5000&&Number.isFinite(ask)&&Number.isFinite(bid)&&Number.isFinite(mid);
    if(!fresh){order.status='SKIPPED_STALE_QUOTE';order.reason='Fresh best bid and ask quotes are required.';return false}
    const limitPrice=Number((mid-cfg.LIMIT_PRICE_OFFSET).toFixed(3));
    order.calculatedLimitPrice=limitPrice;
    if(limitPrice<cfg.MIN_ENTRY_PRICE){
      order.status='SKIPPED_BELOW_MIN_PRICE';
      order.reason=`Calculated limit price is below the $${cfg.MIN_ENTRY_PRICE.toFixed(2)} minimum.`;
      return false;
    }
    if(limitPrice<=0||limitPrice>=1){
      order.status='SKIPPED_INVALID_LIMIT';
      order.reason='Midpoint minus the configured offset is outside the valid outcome-token price range.';
      return false;
    }
    const reserved=this.orders.reduce((sum,pending)=>sum+
      (pending.status==='PENDING'?(pending.limitPrice||0)*(pending.remainingShares||pending.shares||0):0),0);
    if(reserved+limitPrice*shares>this.cash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';
      order.reason='Insufficient paper cash after reserving for pending limit orders.';
      this.log('PAPER_ENTRY_REJECTED',{id,side,limitPrice,shares,reason:order.reason});
      return false;
    }
    order.limitPrice=limitPrice;order.remainingShares=shares;order.status='PENDING';
    order.submittedAt=now;order.quoteAtSubmission=quote.updatedAt;
    order.expiresAt=order.windowStart+this.windowMs;
    order.fillModel='PAPER_FRESH_ASK_WALK_THROUGH';order.fee=0;order.estimatedMakerRebate=0;
    this.log('PAPER_LIMIT_ORDER_PLACED',{id,side,entryMode,checkpointSeconds:order.secondsIntoWindow,
      limitPrice,shares,ask,bid,midpoint:mid,fee:0});
    return true;
  }
  processPendingLimitOrders(now){
    for(const order of this.orders){
      if(order.status!=='PENDING')continue;
      if(this.completedWindows.has(order.windowStart)){
        order.status='EXPIRED_WINDOW_COMPLETE';order.expiredAt=now;order.remainingShares=0;continue;
      }
      if(now>=order.windowStart+this.windowMs){
        order.status='EXPIRED_UNFILLED';order.expiredAt=now;order.remainingShares=0;continue;
      }
      const cutoffSeconds=this.timeframe==='15m'?cfg.ENTRY_CUTOFF_SECONDS_15M:cfg.ENTRY_CUTOFF_SECONDS_5M;
      if(now>=order.windowStart+cutoffSeconds*1000){
        order.status='EXPIRED_CUTOFF';order.expiredAt=now;order.remainingShares=0;
        order.reason=`Entry cutoff reached at ${cutoffSeconds} seconds into the window.`;continue;
      }
      if(Number(order.limitPrice)<cfg.MIN_ENTRY_PRICE){
        order.status='REJECTED_BELOW_MIN_PRICE';order.expiredAt=now;order.remainingShares=0;
        order.reason=`Limit orders below $${cfg.MIN_ENTRY_PRICE.toFixed(2)} are disabled.`;
        continue;
      }
      if(!this.market||this.market.start!==order.windowStart)continue;
      const quote=this.liveQuotes[order.side],ask=Number(quote?.bestAsk);
      const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
        &&now-quote.updatedAt<=5000&&quote.updatedAt>order.quoteAtSubmission&&Number.isFinite(ask);
      if(!fresh||ask<cfg.MIN_ENTRY_PRICE||ask>order.limitPrice+1e-9)continue;
      const shares=order.remainingShares||order.shares,cost=order.limitPrice*shares;
      const maker=makerRebateFor(this.market,order.limitPrice,shares);
      if(cost>this.cash+1e-9){
        order.status='REJECTED_INSUFFICIENT_CASH';
        order.reason='Cash was no longer available when the limit price was crossed.';
        order.remainingShares=0;continue;
      }
      const position={id:order.id,timeframe:this.timeframe,windowMs:this.windowMs,
        windowStart:order.windowStart,marketId:this.market.id,slug:this.market.slug,
        title:this.market.title,side:order.side,tokenId:this.market.tokens[order.side],
        entryKey:order.id,entryLabel:`${order.side} signal limit buy ${usdPrice(order.limitPrice)} · ${shares} shares`,
        entryMode:order.entryMode,checkpoint:order.checkpoint,secondsIntoWindow:order.secondsIntoWindow,
        entryType:order.entryType,entryTypeLabel:'SIGNAL_PATTERN_LIMIT',pattern:order.pattern,
        limitPrice:order.limitPrice,submittedBid:order.bid,submittedAsk:order.ask,
        submittedMidpoint:order.midpoint,
        orderType:'LIMIT',fillModel:'PAPER_FRESH_ASK_WALK_THROUGH',
        shares,initialShares:shares,avgEntry:order.limitPrice,cost,totalCost:cost,fees:0,
        makerFeeEquivalent:maker.feeEquivalent,estimatedMakerRebate:maker.estimate,
        status:'OPEN',submittedAt:order.submittedAt,openedAt:now,filledAt:now,
        visibleAskSize:quote.askSize,simulatedShares:shares,
        submissionQuotes:order.quotePairAtSubmission,entryQuotes:this.captureQuotePair(now),
        entryQuoteAt:now,entryRegime:{...this.marketRegime}};
      order.status='FILLED';order.filledAt=now;order.positionId=order.id;
      order.fillPrice=order.limitPrice;order.fee=0;order.feeEquivalent=maker.feeEquivalent;
      order.estimatedMakerRebate=maker.estimate;order.remainingShares=0;
      this.cash-=cost;this.positions.unshift(position);
      this.log('PAPER_LIMIT_ORDER_FILLED',{id:order.id,side:order.side,limitPrice:order.limitPrice,
        walkedAsk:ask,shares,fee:0,feeEquivalent:maker.feeEquivalent,
        estimatedMakerRebate:maker.estimate,totalCost:cost});
    }
   }
   processCatchUpMarketOrder(now){
     const start=this.orderWindowStart,checkpoint=start+120_000;
     if(!Number.isFinite(start)||!this.market||this.market.start!==start||
        this.completedWindows.has(start)||now>=start+this.windowMs||!this.windowSignalSide||
        this.catchUpDecision.executed)return;
     if(!this.catchUpDecision.eligible&&this.catchUpDecision.status==='waiting'&&now>=checkpoint){
       const fillsByCheckpoint=this.windowOrders.filter(order=>
         order.entryType==='SIGNAL_PATTERN_LIMIT'&&order.status==='FILLED'&&
         Number.isFinite(order.filledAt)&&order.filledAt<=checkpoint).length;
        this.catchUpDecision=fillsByCheckpoint<=2
          ?{status:'watching_price',eligible:true,executed:false,checkedAt:now,
            reason:`${fillsByCheckpoint} rungs filled by 2 minutes; buying the remaining rungs together when the signalled-side CLOB best ask is above $0.60 and below $0.70.`}
         :{status:'not_eligible',eligible:false,executed:false,checkedAt:now,
            reason:`${fillsByCheckpoint} rungs filled by 2 minutes; CHoCH catch-up requires two or fewer.`};
       this.log('PAPER_CHOCH_CHECKPOINT',{windowStart:start,signalSide:this.windowSignalSide,
         fillsByCheckpoint,eligible:this.catchUpDecision.eligible,reason:this.catchUpDecision.reason});
     }
     if(!this.catchUpDecision.eligible)return;
     const side=this.windowSignalSide,quote=this.liveQuotes[side],ask=Number(quote?.bestAsk);
     const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&
       quote.updatedAt>=checkpoint&&now-quote.updatedAt<=5000&&Number.isFinite(ask);
     if(!fresh||ask<=0.60||ask>=0.70)return;
     const pending=this.windowOrders.filter(order=>
       order.entryType==='SIGNAL_PATTERN_LIMIT'&&order.side===side&&order.status==='PENDING');
     const shares=pending.reduce((sum,order)=>sum+Math.max(0,Number(order.remainingShares??order.shares)||0),0);
     if(shares<=0){
       this.catchUpDecision={...this.catchUpDecision,status:'no_remaining_shares',eligible:false,
         reason:'No unfilled rung shares remain for the combined market buy.'};
       return;
     }
     const fillPrice=ask,cost=fillPrice*shares,fee=makerRebateFor(this.market,fillPrice,shares).feeEquivalent;
     if(cost+fee>this.cash+1e-9){
       this.catchUpDecision={...this.catchUpDecision,status:'insufficient_cash',checkedAt:now,
         reason:'Insufficient paper cash for the combined market buy.'};
       return;
     }
     const id=`${this.timeframe}-${start}-choch-market`;
     for(const order of pending){
       order.status='CANCELLED_CONSOLIDATED_MARKET_BUY';order.cancelledAt=now;
       order.remainingShares=0;order.reason='Replaced by the combined CHoCH paper market buy.';
     }
     const marketOrder={id,timeframe:this.timeframe,windowStart:start,side,signalSide:side,
       tokenId:this.market.tokens[side],orderType:'MARKET',entryMode:'SIGNALLED_SIDE_CHOCH',
       entryType:'CLOB_CHOCH_MARKET_BUY',entryTypeLabel:'CLOB CHoCH market buy',
       shares,remainingShares:0,status:'FILLED',createdAt:now,submittedAt:now,filledAt:now,
       fillPrice,limitPrice:null,averageFillPrice:fillPrice,fee,estimatedMakerRebate:0,
       pattern:this.candleEvaluation.pattern,fillModel:'PAPER_CLOB_BEST_ASK_MARKET',
       reason:'After 2 minutes, signalled-side CLOB best ask entered ($0.60, $0.70).'};
     const position={id,timeframe:this.timeframe,windowMs:this.windowMs,windowStart:start,
       marketId:this.market.id,slug:this.market.slug,title:this.market.title,side,
       tokenId:this.market.tokens[side],entryKey:id,
       entryLabel:`${side} CHoCH market buy · ${shares} shares`,entryMode:'SIGNALLED_SIDE_CHOCH',
       entryType:'CLOB_CHOCH_MARKET_BUY',entryTypeLabel:'CLOB CHoCH market buy',
       pattern:this.candleEvaluation.pattern,orderType:'MARKET',fillModel:marketOrder.fillModel,
       shares,initialShares:shares,avgEntry:fillPrice,fillPrice,cost,totalCost:cost+fee,fees:fee,
       makerFeeEquivalent:0,estimatedMakerRebate:0,status:'OPEN',submittedAt:now,openedAt:now,filledAt:now,
       visibleAskSize:quote.askSize,simulatedShares:shares,submissionQuotes:this.captureQuotePair(now),
       entryQuotes:this.captureQuotePair(now),entryQuoteAt:now,entryRegime:{...this.marketRegime}};
     marketOrder.positionId=id;
     this.orders.unshift(marketOrder);this.windowOrders.unshift(marketOrder);
     if(this.orders.length>1000)this.orders.length=1000;
     this.positions.unshift(position);this.cash-=cost+fee;this.totalOrderAttempts++;
     this.catchUpDecision={status:'filled',eligible:true,executed:true,checkedAt:now,side,price:fillPrice,
       shares,orderId:id,reason:`${shares} remaining shares bought together at ${usdPrice(fillPrice)} after CLOB CHoCH confirmation.`};
     this.log('PAPER_CHOCH_MARKET_BUY_FILLED',{id,windowStart:start,side,price:fillPrice,shares,cost,fee,
       cancelledRungs:pending.length,signalPattern:this.candleEvaluation.pattern});
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
    this.processPendingLimitOrders(now);
    const open=this.positions.filter(p=>p.status==='OPEN');
    for(const p of open){
      if(p.windowStart===this.market.start){
        const q=this.liveQuotes[p.side];
        p.markBid=q?.bestBid??null;p.markUpdatedAt=q?.updatedAt||now;p.markStatus=q?.bestBid!=null?'LIVE':'MISSING';
        if(p.status==='OPEN'){
          if(p.status==='OPEN'&&takeProfitHit(q,now))await this.completeWindow(p.windowStart,p,true,'TAKE_PROFIT_BID',Number(q.bestBid),now);
          else if(p.status==='OPEN'&&stopLossHit(q,now))await this.completeWindow(p.windowStart,p,false,'STOP_LOSS_BID',Number(q.bestBid),now);
        }
      }
    }
    const due=open.filter(p=>p.windowStart!==this.market.start&&p.tokenId&&now-(p.lastMarkAttempt||0)>=5000);
    await Promise.all(due.map(async p=>{
      p.lastMarkAttempt=now;
      try{
        const q=quoteFromBook(await md.getBook(p.tokenId),now);
        p.markBid=q.bestBid;p.markUpdatedAt=now;p.markStatus=q.bestBid!=null?'LIVE':'MISSING';
        if(p.status==='OPEN'&&takeProfitHit(q,now))await this.completeWindow(p.windowStart,p,true,'TAKE_PROFIT_BID',Number(q.bestBid),now);
        else if(p.status==='OPEN'&&stopLossHit(q,now))await this.completeWindow(p.windowStart,p,false,'STOP_LOSS_BID',Number(q.bestBid),now);
      }
      catch(_){p.markStatus=p.markBid!=null?'STALE':'MISSING'}
    }));
  }
  finalizePosition(p,won,reason,triggerQuote){
    if(p.status!=='OPEN')return;
    const settledAt=Date.now();
    const takeProfit=reason==='TAKE_PROFIT_BID'||reason==='TP_HIT_0_99';
    const stopLoss=reason==='STOP_LOSS_BID'||reason.startsWith('STOP_LOSS_HIT_');
    p.payout=won?1:0;
    p.proceeds=won?p.shares:0;
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost;
    p.status='SETTLED_EXIT';
    p.settledAt=settledAt;
    p.settlementBasis=reason;
    p.exitReason=takeProfit||stopLoss?reason:null;
    p.tpTriggerQuote=takeProfit?triggerQuote:null;
    p.stopTriggerQuote=stopLoss?triggerQuote:null;
    p.exitBid=Number.isFinite(Number(triggerQuote))?Number(triggerQuote):null;
    this.captureExitQuotes(p,settledAt,p.exitBid,p.exitBid!=null);
    this.cash+=p.proceeds;
    const event=takeProfit?'PAPER_TP_HIT':stopLoss?'PAPER_STOP_LOSS':won?'PAPER_OFFICIAL_WIN':'PAPER_OFFICIAL_LOSS';
    this.log(event,{id:p.id,status:p.status,pnl:p.realizedPnl,side:p.side,shares:p.shares,
      proceeds:p.proceeds,triggerQuote,tpTarget:.99,stopLoss:p.stopLossThreshold??.01,reason});
    this.updateRecoveryAfterClose(p);
  }
  async completeWindow(windowStart,triggerPosition,triggerWon,triggerReason,triggerQuote,now=Date.now()){
    if(this.completedWindows.has(windowStart))return false;
    this.completedWindows.set(windowStart,{completedAt:now,reason:triggerReason});
    for(const order of this.orders){
      if(order.windowStart===windowStart&&['PENDING','LIVE','MARKET_PENDING'].includes(order.status)){
        order.status='EXPIRED_WINDOW_COMPLETE';order.expiredAt=now;order.remainingShares=0;
      }
    }
    const open=this.positions.filter(p=>p.windowStart===windowStart&&p.status==='OPEN');
    const quoteCache=new Map();
    const readQuote=async p=>{
      if(p===triggerPosition)return {bestBid:triggerQuote,updatedAt:now,status:'LIVE'};
      if(p.windowStart===this.market?.start){
        const current=this.liveQuotes[p.side];
        if(current?.status==='LIVE'&&current.bestBid!=null&&Number.isFinite(current.updatedAt)&&now-current.updatedAt<=5000)return current;
      }
      if(!p.tokenId)return null;
      if(!quoteCache.has(p.tokenId)){
        quoteCache.set(p.tokenId,md.getBook(p.tokenId).then(book=>quoteFromBook(book,now)).catch(()=>null));
      }
      return quoteCache.get(p.tokenId);
    };
    const quotes=await Promise.all(open.map(async p=>[p,await readQuote(p)]));
    for(const [p,q] of quotes){
      if(p.status!=='OPEN')continue;
      if(p===triggerPosition){
        this.finalizePosition(p,triggerWon,triggerReason,triggerQuote);
      }else if(takeProfitHit(q,now)){
        this.finalizePosition(p,true,'TAKE_PROFIT_BID',Number(q.bestBid));
      }else if(stopLossHit(q,now)){
        this.finalizePosition(p,false,'STOP_LOSS_BID',Number(q.bestBid));
      }else if(q?.bestBid!=null&&Number.isFinite(Number(q.bestBid))){
        this.finalizeWindowLiquidation(p,Number(q.bestBid),'WINDOW_EXIT_BID',now);
      }else{
        this.finalizeWindowLiquidation(p,0,'WINDOW_EXIT_NO_BID',now);
      }
    }
    this.log('PAPER_WINDOW_COMPLETED',{windowStart,reason:triggerReason,closedPositions:open.length});
    return true;
  }
  finalizeWindowLiquidation(p,bid,reason,now=Date.now()){
    if(p.status!=='OPEN')return;
    const hasBid=reason.endsWith('_BID');
    p.payout=Math.max(0,Math.min(1,bid));
    p.proceeds=p.shares*p.payout;
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost;
    p.status='SETTLED_EXIT';
    p.settledAt=now;
    p.settlementBasis=reason;
    p.exitReason=reason;
    p.exitBid=hasBid?Number(bid):null;
    this.captureExitQuotes(p,now,p.exitBid,hasBid);
    this.cash+=p.proceeds;
    this.log(reason==='WINDOW_EXIT_NO_BID'?'PAPER_WINDOW_EXIT_NO_BID':'PAPER_WINDOW_EXIT_BID',
      {id:p.id,side:p.side,shares:p.shares,exitBid:p.exitBid,proceeds:p.proceeds,pnl:p.realizedPnl,windowStart:p.windowStart});
    this.updateRecoveryAfterClose(p);
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
    const equityCurve=[{ts:this.startedAt,equity:this.capital}];
    let curveEquity=this.capital,peak=this.capital,maxDrawdown=0,maxConsecutiveLosses=0,lossStreak=0;
    for(const p of history){
      curveEquity+=Number(p.realizedPnl)||0;
      equityCurve.push({ts:p.settledAt||p.openedAt,equity:curveEquity});
      peak=Math.max(peak,curveEquity);maxDrawdown=Math.max(maxDrawdown,peak-curveEquity);
      if((Number(p.realizedPnl)||0)<0){lossStreak++;maxConsecutiveLosses=Math.max(maxConsecutiveLosses,lossStreak)}
      else lossStreak=0;
    }
    let unrealizedPnl=0,unpricedOpenPositions=0,markedValue=0;
    for(const p of this.positions){
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
      return {now,mode:'DEMO ONLY',status:this.status,error:this.error,
         strategy:{timeframe:this.timeframe,market:'Polymarket BTC 5-minute UP/DOWN',capital:this.capital,
               regime:{...this.marketRegime,entryPolicy:`Use BTC candle patterns to select the signal side; place $0.30 and $0.20 paper limits for 500 shares each every ${this.timeframe} window.`},
           btcPriceFeed:this.priceFeed.snapshot(),
             entries:{orderType:'LIMIT',sideIndependent:false,side:this.windowStrategySide,
               signalSide:this.windowSignalSide,signal:this.candleEvaluation,
                  sharesPerRung:500,totalShares:cfg.SIGNAL_LIMIT_RUNGS.reduce((sum,rung)=>sum+rung.shares,0),
                   recovery:{enabled:true,triggerRungs:[0.30,0.20],trigger:'take profit at $0.99',
                     entry:'next window, market paper buy opposite that window signal',
                     baseShares:cfg.RECOVERY_BASE_SHARES,maxMartingaleLevel:cfg.RECOVERY_MAX_MARTINGALE_LEVEL,
                     ...this.recovery},
                   cutoffSeconds:this.timeframe==='15m'?cfg.ENTRY_CUTOFF_SECONDS_15M:cfg.ENTRY_CUTOFF_SECONDS_5M,
                   catchUp:{enabled:false,...this.catchUpDecision},
                 rungs:cfg.SIGNAL_LIMIT_RUNGS.map(rung=>({...rung})),
                   direction:'Uses detected completed-candle formations or the direction of the latest completed candle; a doji needs a valid directional rule, otherwise the bot waits.',
                  timing:`Submit $0.30 and $0.20 500-share signal-side paper limits each ${this.timeframe} window.`,
                 fill:'A rung fills at its limit when a newer fresh signal-side best ask is at or below that limit.',
                  unfilled:`Unfilled limits expire at the ${this.timeframe} entry cutoff or window rollover.`,
                 rebateFormula:'Estimated maker rebate = quantity × market taker-fee rate × [price × (1 − price)]^fee exponent × maker-rebate pool share.'},
          merge:{enabled:false},
           exit:'A fresh own-side best bid >= $0.99 pays $1/share; <= $0.01 pays $0/share and completes that window. All other positions close at their own bid (or $0 if no bid). No shares carry over. No official results are used.',
           direction:`Every ${this.timeframe} window places the two configured limit buys on the selected candle signal side.`,
             entryFillModel:'Paper limit fills only when a newer fresh own-side best ask touches the limit price.',
          fees:'Maker fills have zero fees. Crypto rebate estimates are illustrative; actual daily rebates depend on market-wide maker activity.',
          execution:'PAPER ONLY'},
         account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,estimatedMakerRebate,
          totalTrades,settledTrades,wins,losses,profitableExits,losingExits,breakEvenExits,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
          openPositions:this.positions.filter(p=>p.status==='OPEN').length,
         maxConsecutiveLosses,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
          wins,losses,equityCurve},
       window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end,
         complete:this.completedWindows.has(this.market.start),completionReason:this.completedWindows.get(this.market.start)?.reason||null}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
        scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
           source:'Polymarket Gamma/CLOB plus Chainlink BTC/USD reference feed (regime is informational only)',
             marketResolution:'A fresh own-side CLOB bid >= $0.99 pays $1/share or <= $0.01 pays $0/share and completes that window. Remaining positions close at their own bid (or $0 if no bid) at threshold completion or when the next window begins. No shares carry over and no official results are used.'},
       inventory,positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
       start(){if(this.running)return;this.running=true;this.priceFeed.start();this.log('BOT_STARTED',{timeframe:this.timeframe,note:'Paper-only candle signal; $0.30 and $0.20 limit buys for 500 shares each; no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer);this.priceFeed.stop()}
}
module.exports=WickBot;
module.exports._test={simulateAtBestAsk,quoteFromBook,clobWinner,clobQuoteWinner,clobQuoteValue,clobQuoteFloor,takeProfitHit,stopLossHit};
