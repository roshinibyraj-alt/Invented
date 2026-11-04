'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');

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
function takeProfitHit(q,now=Date.now(),target=cfg.TAKE_PROFIT_PRICE){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid>=target}
function stopLossHit(q,now=Date.now(),target=cfg.STOP_LOSS_PRICE){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid<=target}
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
  constructor({timeframe='5m',windowMs=cfg.WINDOW_MS_5M,capital=cfg.DEMO_CAPITAL_5M}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.startedAt=Date.now();
    this.positions=[];this.events=[];this.status='starting';this.completedWindows=new Map();
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.totalOrderAttempts=0;
    this.windowOrders=[];this.orderWindowStart=null;this.running=false;
    this.windowStrategySide=null;
    this.windowSignalSide=null;
    this.windowEntryPlaced=false;
    this.windowEntryOrderId=null;
    this.windowTrigger=null;
    const baseStakeUsd=Number((this.capital*cfg.BASE_STAKE_FRACTION).toFixed(2));
    this.stakeProgression={baseStakeUsd,stakeUsd:baseStakeUsd,martingaleLevel:0,
      extraStakePhase:false,remainingExtraStopOuts:0,stopped:false,lastOutcome:null};
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
      if(this.orderWindowStart!==start)this.openStrategyWindow(start,now);
       this.processThresholdEntry(start,now);
      if(now>=start+this.windowMs-3000&&now<start+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===start&&p.status==='OPEN')p.closeQuotes=this.closeQuotes;
      }
      this.lastScanAt=now;this.error=null;
      const hasOpen=this.positions.some(p=>p.windowStart===start&&p.status==='OPEN');
      this.status=this.stakeProgression.stopped?'strategy_stopped':
        this.completedWindows.has(start)?'window_complete':hasOpen?'position_open':'scanning';
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
  openStrategyWindow(start,now){
    this.orderWindowStart=start;
    this.windowOrders=[];
    this.windowStrategySide=null;
    this.windowSignalSide=null;
    this.windowEntryPlaced=false;
    this.windowEntryOrderId=null;
    this.windowTrigger=null;
    this.log('PAPER_THRESHOLD_WINDOW_STARTED',{windowStart:start,timeframe:this.timeframe,
      nextStakeUsd:this.stakeProgression.stakeUsd});
  }
  processThresholdEntry(start,now){
    if(this.completedWindows.has(start)||this.orderWindowStart!==start||this.windowEntryPlaced||
       this.stakeProgression.stopped||!this.market||this.market.start!==start||
       now<start+cfg.ENTRY_DELAY_MS)return false;
    const candidates=['UP','DOWN'].map(side=>{
      const quote=this.liveQuotes[side],mid=Number(quote?.mid);
      const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&
        now-quote.updatedAt<=5000&&Number.isFinite(mid)&&mid>=cfg.ENTRY_TRIGGER_PRICE;
      return fresh?{side,quote,mid}:null;
    }).filter(Boolean).sort((a,b)=>b.mid-a.mid);
    if(!candidates.length)return false;
    const {side,quote,mid}=candidates[0];
    const stakeUsd=this.stakeProgression.stakeUsd;
    const shares=Number((stakeUsd/cfg.ENTRY_LIMIT_PRICE).toFixed(6));
    const cost=Number((shares*cfg.ENTRY_LIMIT_PRICE).toFixed(6));
    const id=`${this.timeframe}-${start}-threshold-entry`;
    this.windowEntryPlaced=true;
    this.windowEntryOrderId=id;
    this.windowSignalSide=side;
    this.windowStrategySide=side;
    this.windowTrigger={side,mid,observedAt:now,stakeUsd,shares};
    const reserved=this.orders.reduce((sum,order)=>sum+
      (order.status==='PENDING'?(order.limitPrice||0)*(order.remainingShares||order.shares||0):0),0);
    const order={id,timeframe:this.timeframe,windowStart:start,side,signalSide:side,
      tokenId:this.market.tokens[side],orderType:'LIMIT',entryMode:'PRICE_THRESHOLD',
      entryType:'THRESHOLD_LIMIT_BUY',triggerPrice:cfg.ENTRY_TRIGGER_PRICE,
      triggerMid:mid,limitPrice:cfg.ENTRY_LIMIT_PRICE,stakeUsd,shares,remainingShares:shares,
      status:'PENDING',createdAt:now,submittedAt:now,quoteAtSubmission:quote.updatedAt,
      expiresAt:start+this.windowMs,fee:0,
      estimatedMakerRebate:makerRebateFor(this.market,cfg.ENTRY_LIMIT_PRICE,shares).estimate,
      fillModel:'PAPER_RESTING_LIMIT_ASK_AT_OR_BELOW_LIMIT',
      progressionLevel:this.stakeProgression.martingaleLevel,
      extraStakeWindow:this.stakeProgression.extraStakePhase};
    this.totalOrderAttempts++;
    this.windowOrders.push(order);this.orders.unshift(order);
    if(this.orders.length>1000)this.orders.length=1000;
    if(cost+reserved>this.cash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';
      order.remainingShares=0;
      order.reason='The configured stake exceeds available paper cash.';
      this.log('PAPER_THRESHOLD_ORDER_REJECTED',{id,side,stakeUsd,cost,cash:this.cash});
      return false;
    }
    this.log('PAPER_THRESHOLD_LIMIT_ORDER_PLACED',{id,windowStart:start,side,triggerMid:mid,
      triggerPrice:cfg.ENTRY_TRIGGER_PRICE,limitPrice:cfg.ENTRY_LIMIT_PRICE,stakeUsd,shares});
    return true;
  }
  updateStakeProgressionAfterClose(position){
    if(position.progressionApplied)return;
    position.progressionApplied=true;
    const pnl=Number(position.realizedPnl)||0,progress=this.stakeProgression;
    if(pnl>1e-9){
      progress.baseStakeUsd=Number((this.cash*cfg.BASE_STAKE_FRACTION).toFixed(2));
      progress.stakeUsd=progress.baseStakeUsd;
      progress.martingaleLevel=0;progress.extraStakePhase=false;
      progress.remainingExtraStopOuts=0;progress.stopped=false;progress.lastOutcome='WIN';
    }else if(pnl < -1e-9){
      progress.lastOutcome='LOSS';
      if(position.extraStakeWindow){
        progress.remainingExtraStopOuts=Math.max(0,progress.remainingExtraStopOuts-1);
        progress.stakeUsd=progress.baseStakeUsd*Math.pow(cfg.LOSS_MULTIPLIER,cfg.MAX_MULTIPLIER_LEVELS);
        if(progress.remainingExtraStopOuts===0)progress.stopped=true;
      }else if(Number(position.progressionLevel)<cfg.MAX_MULTIPLIER_LEVELS){
        progress.martingaleLevel=Number(position.progressionLevel)+1;
        progress.stakeUsd=progress.baseStakeUsd*Math.pow(cfg.LOSS_MULTIPLIER,progress.martingaleLevel);
      }else{
        progress.martingaleLevel=cfg.MAX_MULTIPLIER_LEVELS;
        progress.extraStakePhase=true;
        progress.remainingExtraStopOuts=cfg.MAX_EXTRA_STOP_OUTS;
        progress.stakeUsd=progress.baseStakeUsd*Math.pow(cfg.LOSS_MULTIPLIER,cfg.MAX_MULTIPLIER_LEVELS);
      }
    }else{
      progress.lastOutcome='BREAKEVEN';
    }
    if(progress.stopped)this.status='strategy_stopped';
    this.log('PAPER_STAKE_PROGRESSION_UPDATED',{positionId:position.id,pnl,
      baseStakeUsd:progress.baseStakeUsd,nextStakeUsd:progress.stakeUsd,
      martingaleLevel:progress.martingaleLevel,remainingExtraStopOuts:progress.remainingExtraStopOuts,
      stopped:progress.stopped,lastOutcome:progress.lastOutcome});
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
      if(!this.market||this.market.start!==order.windowStart)continue;
      const quote=this.liveQuotes[order.side],ask=Number(quote?.bestAsk);
      const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
        &&now-quote.updatedAt<=5000&&quote.updatedAt>order.quoteAtSubmission&&Number.isFinite(ask);
      if(!fresh||ask<=0||ask>order.limitPrice+1e-9)continue;
      const shares=order.remainingShares||order.shares;
      const fillPrice=Math.min(order.limitPrice,ask);
      const cost=Number((fillPrice*shares).toFixed(6));
      const maker=makerRebateFor(this.market,order.limitPrice,shares);
      if(cost>this.cash+1e-9){
        order.status='REJECTED_INSUFFICIENT_CASH';
        order.reason='Cash was no longer available when the limit price was crossed.';
        order.remainingShares=0;continue;
      }
      const position={id:order.id,timeframe:this.timeframe,windowMs:this.windowMs,
        windowStart:order.windowStart,marketId:this.market.id,slug:this.market.slug,
        title:this.market.title,side:order.side,tokenId:this.market.tokens[order.side],
        entryKey:order.id,entryLabel:`${order.side} limit buy ${usdPrice(fillPrice)} · ${shares} shares`,
        entryMode:order.entryMode,entryType:order.entryType,
        triggerPrice:order.triggerPrice,triggerMid:order.triggerMid,stakeUsd:order.stakeUsd,
        progressionLevel:order.progressionLevel,extraStakeWindow:order.extraStakeWindow,
        stopLossThreshold:cfg.STOP_LOSS_PRICE,takeProfitThreshold:cfg.TAKE_PROFIT_PRICE,
        limitPrice:order.limitPrice,orderType:'LIMIT',fillModel:order.fillModel,
        shares,initialShares:shares,avgEntry:fillPrice,fillPrice,cost,totalCost:cost,fees:0,
        makerFeeEquivalent:maker.feeEquivalent,estimatedMakerRebate:maker.estimate,
        status:'OPEN',submittedAt:order.submittedAt,openedAt:now,filledAt:now,
        visibleAskSize:quote.askSize,simulatedShares:shares,
        entryQuotes:this.captureQuotePair(now),entryQuoteAt:now,
        feeContext:order.feeContext};
      order.status='FILLED';order.filledAt=now;order.positionId=order.id;
      order.fillPrice=fillPrice;order.fee=0;order.feeEquivalent=maker.feeEquivalent;
      order.estimatedMakerRebate=maker.estimate;order.remainingShares=0;
      this.cash-=cost;this.positions.unshift(position);
      this.log('PAPER_LIMIT_ORDER_FILLED',{id:order.id,side:order.side,limitPrice:order.limitPrice,
        fillPrice,walkedAsk:ask,shares,fee:0,feeEquivalent:maker.feeEquivalent,
        estimatedMakerRebate:maker.estimate,totalCost:cost});
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
    const takeProfit=reason==='TAKE_PROFIT_BID';
    const stopLoss=reason==='STOP_LOSS_BID';
    const exitPrice=Number.isFinite(Number(triggerQuote))?Math.max(0,Math.min(1,Number(triggerQuote))):null;
    p.payout=takeProfit?cfg.TAKE_PROFIT_PAYOUT_PER_SHARE:exitPrice??(won?1:0);
    p.proceeds=takeProfit?p.shares*cfg.TAKE_PROFIT_PAYOUT_PER_SHARE:
      stopLoss&&exitPrice!=null?p.shares*exitPrice:won?p.shares:0;
    p.exitFees=stopLoss&&exitPrice!=null?takerFeeFor(p.feeContext||this.market,exitPrice,p.shares):0;
    p.realizedPnl=p.proceeds-p.totalCost-p.exitFees;
    p.status='SETTLED_EXIT';
    p.settledAt=settledAt;
    p.settlementBasis=reason;
    p.exitReason=takeProfit||stopLoss?reason:null;
    p.tpTriggerQuote=takeProfit?triggerQuote:null;
    p.stopTriggerQuote=stopLoss?triggerQuote:null;
    p.exitBid=exitPrice;
    p.exitType=takeProfit?'LIMIT':stopLoss?'MARKET':'SETTLEMENT';
    this.captureExitQuotes(p,settledAt,p.exitBid,p.exitBid!=null);
    this.cash+=p.proceeds-p.exitFees;
    const event=takeProfit?'PAPER_TP_HIT':stopLoss?'PAPER_STOP_LOSS':won?'PAPER_OFFICIAL_WIN':'PAPER_OFFICIAL_LOSS';
    this.log(event,{id:p.id,status:p.status,pnl:p.realizedPnl,side:p.side,shares:p.shares,
      proceeds:p.proceeds,exitFees:p.exitFees,triggerQuote,
      tpTarget:cfg.TAKE_PROFIT_PRICE,stopLoss:cfg.STOP_LOSS_PRICE,reason});
    this.updateStakeProgressionAfterClose(p);
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
    p.exitFees=hasBid?takerFeeFor(p.feeContext||this.market,p.payout,p.shares):0;
    p.realizedPnl=p.proceeds-p.totalCost-p.exitFees;
    p.status='SETTLED_EXIT';
    p.settledAt=now;
    p.settlementBasis=reason;
    p.exitReason=reason;
    p.exitBid=hasBid?Number(bid):null;
    p.exitType=hasBid?'MARKET':'WINDOW_SETTLEMENT';
    this.captureExitQuotes(p,now,p.exitBid,hasBid);
    this.cash+=p.proceeds-p.exitFees;
    this.log(reason==='WINDOW_EXIT_NO_BID'?'PAPER_WINDOW_EXIT_NO_BID':'PAPER_WINDOW_EXIT_BID',
      {id:p.id,side:p.side,shares:p.shares,exitBid:p.exitBid,proceeds:p.proceeds,
        exitFees:p.exitFees,pnl:p.realizedPnl,windowStart:p.windowStart});
    this.updateStakeProgressionAfterClose(p);
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
            entries:{orderType:'LIMIT',sideIndependent:true,side:this.windowStrategySide,
              signalSide:this.windowSignalSide,signal:{side:this.windowSignalSide,
                reason:this.windowTrigger
                  ?`${this.windowSignalSide} midpoint reached ${usdPrice(this.windowTrigger.mid)} after the 30-second wait.`
                  :'Waiting until 30 seconds, then for either side midpoint to reach $0.77.',
                triggerMid:this.windowTrigger?.mid??null,
                ready:!!this.windowTrigger},
              waitSeconds:cfg.ENTRY_DELAY_MS/1000,triggerPrice:cfg.ENTRY_TRIGGER_PRICE,
              limitPrice:cfg.ENTRY_LIMIT_PRICE,stakeUsd:this.windowTrigger?.stakeUsd??this.stakeProgression.stakeUsd,
              shares:this.windowTrigger?.shares??null,entryPlaced:this.windowEntryPlaced,
              unfilledCarryover:true,progression:{...this.stakeProgression}},
            exit:{stopLossPrice:cfg.STOP_LOSS_PRICE,stopLossType:'MARKET',
              takeProfitPrice:cfg.TAKE_PROFIT_PRICE,
              takeProfitPayoutPerShare:cfg.TAKE_PROFIT_PAYOUT_PER_SHARE,
              windowEnd:'Unfilled buys expire; open positions sell at the current bid or settle at zero if no bid.'},
            timing:'After 30 seconds, place one $0.75 resting limit buy when either fresh midpoint reaches $0.77.',
            fill:'A limit buy fills only on a newer fresh ask at or below $0.75; better ask prices are used as the fill price.',
            unfilled:'Unfilled entry orders expire at the 5-minute window end. No loss is recorded and the same stake carries forward.',
            fees:'Limit buys and take-profit limits have zero maker fees. Stop-loss and window-end market sells use the market taker-fee schedule.',
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
            source:'Polymarket BTC 5-minute Gamma/CLOB order books',
            marketResolution:'$0.99 best bid triggers a $1/share take-profit; $0.40 or lower triggers a market stop-loss. Remaining positions sell at the best bid on window rollover; no-bid positions settle at zero.'},
       inventory,positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
        start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,
          note:'Paper-only 5-minute threshold ladder; $0.75 limit buys after a $0.77 midpoint trigger; no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={quoteFromBook,takerFeeFor,makerRebateFor,takeProfitHit,stopLossHit};
