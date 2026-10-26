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
function simulateAtBestAsk(asks,qty,maxPrice,minPrice=cfg.MIN_ENTRY_ASK){
  const best=levels(asks).find(x=>x.price>=minPrice&&x.price<maxPrice);
  if(!best)return null;
  return {shares:qty,cost:qty*best.price,avg:best.price,visibleDepth:best.size,
    simulatedShares:Math.max(0,qty-best.size)};
}
function feeFor(m,avg,qty){
  if(m?.feesEnabled===false)return 0;
  const rate=Number(m?.feeSchedule?.rate??m?.takerFeeRate??cfg.CRYPTO_TAKER_FEE_RATE);
  const exp=Number(m?.feeSchedule?.exponent??1);
  return Number.isFinite(rate)&&Number.isFinite(exp)&&avg>0&&avg<1&&qty>0
    ? rate*Math.pow(avg*(1-avg),exp)*qty : 0;
}
function makerRebateFor(m,price,qty){
  if(m?.feesEnabled===false)return {feeEquivalent:0,estimate:0};
  const rate=Number(m?.feeSchedule?.rate??m?.takerFeeRate??cfg.CRYPTO_TAKER_FEE_RATE);
  const exponent=Number(m?.feeSchedule?.exponent??1);
  const feeEquivalent=Number.isFinite(rate)&&Number.isFinite(exponent)&&price>0&&price<1&&qty>0
    ?rate*Math.pow(price*(1-price),exponent)*qty:0;
  return {feeEquivalent,estimate:feeEquivalent*cfg.CRYPTO_MAKER_REBATE_RATE};
}
function takeProfitHit(q,now=Date.now()){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid>=.99}
function stopLossHit(q,now=Date.now()){const bid=Number(q?.bestBid);return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&q.bestBid!=null&&Number.isFinite(bid)&&bid<=.01}
class WickBot{
  constructor({timeframe='5m',windowMs=cfg.WINDOW_MS_5M,capital=cfg.DEMO_CAPITAL_5M}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.startedAt=Date.now();
    this.positions=[];this.mergeEvents=[];this.events=[];this.status='starting';
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.windowOrders=[];this.orderWindowStart=null;this.running=false;
    this.windowFiredEntries=0;
    this.lastFiredEntryShares=0;
    this.initialEntrySide=null;
    this.initialEntryAt=null;
    this.martingaleAttempted=false;
    this.quoteWindowStart=null;this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
    this.closeQuotes=null;
    this.completedWindows=new Map();
  }
  log(event,data={}){const e={ts:Date.now(),timeframe:this.timeframe,event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
      await this.closePreviousWindows(start,now);
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
        this.closeQuotes=null;
      }
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
      this.processTimedEntries(start,now);
      if(now>=start+this.windowMs-3000&&now<start+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===start&&(p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT'))p.closeQuotes=this.closeQuotes;
      }
      this.lastScanAt=now;this.error=null;
      const hasOpen=this.positions.some(p=>p.windowStart===start&&(p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT'));
      this.status=hasOpen?'position_open':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
  }
  openStrategyWindow(start,now){
    this.orderWindowStart=start;
    this.lastEntryCheckpoint=0;
    this.windowFiredEntries=0;
    this.lastFiredEntryShares=0;
    this.initialEntrySide=null;
    this.initialEntryAt=null;
    this.martingaleAttempted=false;
    this.windowOrders=[];
    this.log('PAPER_TIMED_ENTRY_STRATEGY_STARTED',{windowStart:start,
      checkIntervalSeconds:cfg.ENTRY_CHECK_INTERVAL_MS/1000,
      baseShares:cfg.BASE_ENTRY_SHARES,
      limitOffset:cfg.LIMIT_PRICE_OFFSET,
      mergeLotShares:cfg.MERGE_LOT_SHARES,
      selectionSchedule:'Every 5 seconds, independently place a 50-share UP and DOWN limit buy at midpoint minus $0.05; merge each matched 50-share pair',
      cutoffSeconds:this.windowMs/1000});
  }
  processTimedEntries(start,now){
    if(this.completedWindows.has(start))return;
    const elapsedMs=now-start;
    if(elapsedMs<cfg.ENTRY_CHECK_INTERVAL_MS||elapsedMs>=this.windowMs)return;
    const checkpoint=Math.floor(elapsedMs/cfg.ENTRY_CHECK_INTERVAL_MS);
    if(checkpoint<1||checkpoint<=this.lastEntryCheckpoint)return;
    this.lastEntryCheckpoint=checkpoint;
    const secondsIntoWindow=checkpoint*cfg.ENTRY_CHECK_INTERVAL_MS/1000;
    for(const side of ['UP','DOWN']){
      this.attemptEntry(start,now,side,cfg.BASE_ENTRY_SHARES,'MIDPOINT_OFFSET',secondsIntoWindow);
    }
  }
  attemptEntry(start,now,side,shares,entryType,secondsIntoWindow){
    const quote=this.liveQuotes[side],ask=Number(quote?.bestAsk),mid=Number(quote?.mid);
    const bid=Number(quote?.bestBid);
    const id=`${this.timeframe}-${start}-${side.toLowerCase()}-check-${Math.floor(secondsIntoWindow/(cfg.ENTRY_CHECK_INTERVAL_MS/1000))}`;
    const order={id,timeframe:this.timeframe,windowStart:start,side,secondsIntoWindow,
      ask:Number.isFinite(ask)?ask:null,bid:Number.isFinite(bid)?bid:null,
      midpoint:Number.isFinite(mid)?mid:null,
      shares,orderType:'LIMIT',status:'SKIPPED',createdAt:now,entryType};
    this.windowOrders.unshift(order);this.orders.unshift(order);
    if(this.orders.length>1000)this.orders.length=1000;
    const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
      &&now-quote.updatedAt<=5000&&Number.isFinite(ask)&&Number.isFinite(bid)&&Number.isFinite(mid);
    if(!fresh){
      order.status='SKIPPED_STALE_QUOTE';
      order.reason='Fresh best bid and ask quotes are required.';
      return false;
    }
    const limitPrice=Number((mid-cfg.LIMIT_PRICE_OFFSET).toFixed(3));
    if(limitPrice<=0||limitPrice>=1){
      order.status='SKIPPED_INVALID_LIMIT';
      order.reason='Midpoint minus the configured offset is outside the valid outcome-token price range.';
      return false;
    }
    const reserved=this.windowOrders.reduce((sum,pending)=>sum+
      (pending.status==='PENDING'?(pending.limitPrice||0)*(pending.remainingShares||pending.shares||0):0),0);
    if(reserved+limitPrice*shares>this.cash+1e-9){
      order.status='REJECTED_INSUFFICIENT_CASH';
      order.reason='Insufficient paper cash after reserving for pending limit orders.';
      this.log('PAPER_ENTRY_REJECTED',{id,side,limitPrice,shares,reason:order.reason,entryType});
      return false;
    }
    order.limitPrice=limitPrice;
    order.remainingShares=shares;
    order.status='PENDING';
    order.submittedAt=now;
    order.quoteAtSubmission=quote.updatedAt;
    order.fillModel='PAPER_FRESH_ASK_WALK_THROUGH';
    order.fee=0;
    order.estimatedMakerRebate=0;
    this.log('PAPER_LIMIT_ORDER_PLACED',{id,side,entryType,secondsIntoWindow,
      limitPrice,shares,ask,bid,midpoint:mid,fee:0});
    return true;
  }
  processPendingLimitOrders(now){
    for(const order of this.orders){
      if(order.status!=='PENDING')continue;
      if(now>=order.windowStart+this.windowMs){
        order.status='EXPIRED_UNFILLED';
        order.expiredAt=now;
        order.remainingShares=0;
        continue;
      }
      if(!this.market||this.market.start!==order.windowStart)continue;
      const quote=this.liveQuotes[order.side],ask=Number(quote?.bestAsk);
      const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
        &&now-quote.updatedAt<=5000&&quote.updatedAt>order.quoteAtSubmission
        &&Number.isFinite(ask);
      if(!fresh||ask>order.limitPrice+1e-9)continue;
      const shares=order.remainingShares||order.shares;
      const cost=order.limitPrice*shares;
      const maker=makerRebateFor(this.market,order.limitPrice,shares);
      if(cost>this.cash+1e-9){
        order.status='REJECTED_INSUFFICIENT_CASH';
        order.reason='Cash was no longer available when the limit price was crossed.';
        order.remainingShares=0;
        continue;
      }
      const position={id:order.id,timeframe:this.timeframe,windowMs:this.windowMs,
      windowStart:order.windowStart,marketId:this.market.id,slug:this.market.slug,
      title:this.market.title,side:order.side,tokenId:this.market.tokens[order.side],
      entryKey:order.id,
      entryLabel:order.side+' midpoint-offset limit buy '+usdPrice(order.limitPrice)+' · '+shares+' shares',
      entryType:`CLOB_${order.entryType}`,orderType:'LIMIT',fillModel:'PAPER_FRESH_ASK_WALK_THROUGH',
      shares,initialShares:shares,avgEntry:order.limitPrice,cost,totalCost:cost,fees:0,
      makerFeeEquivalent:maker.feeEquivalent,estimatedMakerRebate:maker.estimate,
      rebateEstimateNote:'Illustrative only; actual daily rebate depends on each market rebate pool and competing maker fee-equivalent volume.',
      status:'OPEN',submittedAt:order.submittedAt,openedAt:now,filledAt:now,
      visibleAskSize:quote.askSize,simulatedShares:shares};
      order.status='FILLED';order.filledAt=now;order.positionId=order.id;
      order.fillPrice=order.limitPrice;order.fee=0;order.feeEquivalent=maker.feeEquivalent;
      order.estimatedMakerRebate=maker.estimate;order.remainingShares=0;
      this.cash-=cost;this.positions.unshift(position);
      this.windowFiredEntries++;this.lastFiredEntryShares=shares;
      this.log('PAPER_LIMIT_ORDER_FILLED',{id:order.id,side:order.side,entryType:order.entryType,
        limitPrice:order.limitPrice,walkedAsk:ask,shares,fee:0,
        feeEquivalent:maker.feeEquivalent,estimatedMakerRebate:maker.estimate,totalCost:cost});
    }
    this.mergeMatchedPairs(now);
  }
  cancelWindowOrders(windowStart,now,reason){
    for(const order of this.orders){
      if(order.windowStart!==windowStart||order.status!=='PENDING')continue;
      order.status=reason==='WINDOW_ROLLOVER'?'EXPIRED_WINDOW_ROLLOVER':'EXPIRED_WINDOW_COMPLETE';
      order.expiredAt=now;order.remainingShares=0;
    }
  }
  async completeWindow(windowStart,triggerPosition=null,triggerReason='WINDOW_COMPLETE',now=Date.now()){
    if(this.completedWindows.has(windowStart))return false;
    this.completedWindows.set(windowStart,{completedAt:now,reason:triggerReason});
    while(this.completedWindows.size>100)this.completedWindows.delete(this.completedWindows.keys().next().value);
    this.cancelWindowOrders(windowStart,now,triggerReason);
    const quotesByToken=new Map();
    for(const p of this.positions){
      if(p.windowStart!==windowStart||!['OPEN','PENDING_CLOB_RESULT'].includes(p.status))continue;
      let quote=this.market?.start===windowStart?this.liveQuotes[p.side]:null;
      const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)&&now-quote.updatedAt<=5000;
      if(!fresh){
        const tokenId=p.tokenId||this.market?.tokens?.[p.side];
        if(tokenId&&quotesByToken.has(tokenId))quote=quotesByToken.get(tokenId);
        else if(tokenId){
          try{quote=quoteFromBook(await md.getBook(tokenId),now)}catch(_){quote=null}
          quotesByToken.set(tokenId,quote);
        }else quote=null;
      }
      const bid=Number(quote?.bestBid);
      if(quote?.bestBid!=null&&Number.isFinite(bid)&&bid>=0&&bid<=1){
        const reason=p===triggerPosition?triggerReason
          :triggerReason==='WINDOW_ROLLOVER'?'WINDOW_ROLLOVER_BID':'WINDOW_COMPLETE_BID';
        this.finalizeExit(p,bid,reason);
      }else{
        this.finalizeExit(p,0,triggerReason==='WINDOW_ROLLOVER'?'WINDOW_ROLLOVER_NO_BID':'WINDOW_COMPLETE_NO_BID');
      }
    }
    this.log(triggerReason==='WINDOW_ROLLOVER'?'PAPER_WINDOW_ROLLED_OVER':'PAPER_WINDOW_COMPLETED',{
      windowStart,closedPositions:this.positions.filter(p=>p.windowStart===windowStart&&p.status==='SETTLED_EXIT').length});
    return true;
  }
  async closePreviousWindows(currentStart,now=Date.now()){
    const oldStarts=new Set([
      ...this.positions.filter(p=>p.windowStart!==currentStart&&['OPEN','PENDING_CLOB_RESULT'].includes(p.status)).map(p=>p.windowStart),
      ...this.orders.filter(o=>o.windowStart!==currentStart&&o.status==='PENDING').map(o=>o.windowStart),
    ]);
    for(const windowStart of oldStarts)await this.completeWindow(windowStart,null,'WINDOW_ROLLOVER',now);
  }
  mergeMatchedPairs(now=Date.now()){
    if(!this.market)return 0;
    const open=this.positions.filter(p=>p.status==='OPEN'&&p.marketId===this.market.id)
      .sort((a,b)=>(a.openedAt||0)-(b.openedAt||0));
    const totals={UP:0,DOWN:0};
    for(const p of open)totals[p.side]+=Math.max(0,Number(p.shares)||0);
    const lot=cfg.MERGE_LOT_SHARES;
    const mergeable=Math.floor(Math.min(totals.UP,totals.DOWN)/lot)*lot;
    if(!mergeable)return 0;
    const consume=(side,quantity)=>{
      let remaining=quantity,costBasis=0;
      for(const p of open){
        if(p.side!==side||remaining<=1e-9)continue;
        const available=Math.max(0,Number(p.shares)||0);
        const used=Math.min(available,remaining);
        if(!used)continue;
        const basis=Number(p.totalCost||0)*used/available;
        p.shares=available-used;p.totalCost=Math.max(0,Number(p.totalCost||0)-basis);
        p.cost=p.totalCost;p.mergedShares=(p.mergedShares||0)+used;
        p.mergedCost=(p.mergedCost||0)+basis;costBasis+=basis;remaining-=used;
        if(p.shares<=1e-9){p.shares=0;p.status='MERGED';p.settledAt=now}
      }
      return costBasis;
    };
    let merged=0;
    for(let shares=0;shares<mergeable;shares+=lot){
      const costBasis=consume('UP',lot)+consume('DOWN',lot);
      const proceeds=lot,pnl=proceeds-costBasis;
      this.cash+=proceeds;
      const event={id:`merge-${this.market.id}-${now}-${this.mergeEvents.length}`,
        marketId:this.market.id,windowStart:this.market.start,shares:lot,proceeds,costBasis,
        realizedPnl:pnl,mergedAt:now};
      this.mergeEvents.unshift(event);merged+=shares;
      this.log('PAPER_COMPLETE_SET_MERGED',{marketId:event.marketId,shares,
        proceeds,costBasis,realizedPnl:pnl});
    }
    return merged;
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
    const open=this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT');
    const currentWindowOpen=open.filter(p=>p.windowStart===this.market.start&&p.status==='OPEN');
    const takeProfitPosition=currentWindowOpen.find(p=>takeProfitHit(this.liveQuotes[p.side],now));
    const stopLossPosition=currentWindowOpen.find(p=>stopLossHit(this.liveQuotes[p.side],now));
    const trigger=takeProfitPosition||stopLossPosition;
    if(trigger){
      await this.completeWindow(trigger.windowStart,trigger,
        takeProfitPosition?'TAKE_PROFIT_BID':'STOP_LOSS_BID',now);
      return;
    }
    for(const p of open){
      if(p.windowStart===this.market.start){
        const q=this.liveQuotes[p.side];
        p.markBid=q?.bestBid??null;p.markUpdatedAt=q?.updatedAt||now;p.markStatus=q?.bestBid!=null?'LIVE':'MISSING';
      }
    }
    const due=open.filter(p=>p.windowStart!==this.market.start&&p.tokenId&&now-(p.lastMarkAttempt||0)>=5000);
    await Promise.all(due.map(async p=>{
      p.lastMarkAttempt=now;
      try{const q=quoteFromBook(await md.getBook(p.tokenId),now);p.markBid=q.bestBid;p.markUpdatedAt=now;p.markStatus=q.bestBid!=null?'LIVE':'MISSING'}
      catch(_){p.markStatus=p.markBid!=null?'STALE':'MISSING'}
    }));
  }
  finalizeExit(p,exitPrice,reason){
    if(!['OPEN','PENDING_CLOB_RESULT'].includes(p.status)||!Number.isFinite(exitPrice)||exitPrice<0||exitPrice>1)return;
    const proceeds=exitPrice*p.shares,exitFee=feeFor(this.market,exitPrice,p.shares);
    p.exitPrice=exitPrice;p.proceeds=proceeds;p.exitFees=exitFee;p.realizedPnl=proceeds-exitFee-p.totalCost;
    p.status='SETTLED_EXIT';p.settledAt=Date.now();p.settlementBasis=reason;p.exitReason=reason;
    this.cash+=proceeds-exitFee;
    this.log('PAPER_PRICE_EXIT',{id:p.id,side:p.side,shares:p.shares,exitPrice,proceeds,exitFee,realizedPnl:p.realizedPnl,reason});
  }
  snapshot(){
    const now=Date.now();
    const positionRealizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
    const mergeRealizedPnl=this.mergeEvents.reduce((s,e)=>s+(e.realizedPnl||0),0);
    const mergeCostBasis=this.mergeEvents.reduce((s,e)=>s+(e.costBasis||0),0);
    const realizedPnl=positionRealizedPnl+mergeRealizedPnl;
     const takerFees=this.positions.reduce((s,p)=>s+(p.fees||0)+(p.exitFees||0),0);
      const estimatedMakerRebate=this.positions.reduce((s,p)=>s+(p.estimatedMakerRebate||0),0);
      const makerFeeEquivalent=this.positions.reduce((s,p)=>s+(p.makerFeeEquivalent||0),0);
    const officialWins=this.positions.filter(p=>p.status==='SETTLED_WIN').length,officialLosses=this.positions.filter(p=>p.status==='SETTLED_LOSS').length;
    const exits=this.positions.filter(p=>p.status==='SETTLED_EXIT').length;
    const profitableExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&(Number(p.realizedPnl)||0)>0).length;
    const losingExits=this.positions.filter(p=>p.status==='SETTLED_EXIT'&&(Number(p.realizedPnl)||0)<0).length;
    const breakEvenExits=exits-profitableExits-losingExits;
    const wins=officialWins+profitableExits,losses=officialLosses+losingExits;
    const settledTrades=officialWins+officialLosses+exits,totalTrades=this.positions.filter(p=>p.status!=='CANCELLED_UNFILLED').length;
    const history=[
      ...this.positions.filter(p=>p.status==='SETTLED_WIN'||p.status==='SETTLED_LOSS'||p.status==='SETTLED_EXIT'),
      ...this.mergeEvents.map(e=>({settledAt:e.mergedAt,realizedPnl:e.realizedPnl})),
    ].sort((a,b)=>(a.settledAt||0)-(b.settledAt||0));
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
      if(p.status!=='OPEN'&&p.status!=='PENDING_CLOB_RESULT'){
        p.markValue=0;p.unrealizedPnl=0;p.markStatus='CLOSED';continue;
      }
      const mark=p.markBid==null?null:p.markBid*p.shares;p.markAgeMs=p.markUpdatedAt?Math.max(0,now-p.markUpdatedAt):null;p.markStatus=mark==null?'UNAVAILABLE':p.markAgeMs>15000?'STALE':'LIVE';const freshMark=mark!=null&&p.markAgeMs<=15000;p.markValue=freshMark?mark:null;p.unrealizedPnl=freshMark?mark-p.totalCost:null;if(!freshMark)unpricedOpenPositions++;else{markedValue+=mark;unrealizedPnl+=p.unrealizedPnl}
    }
    const activePositions=this.positions.filter(p=>p.status==='OPEN'&&p.marketId===this.market?.id);
    const unmatchedUpShares=activePositions.filter(p=>p.side==='UP').reduce((s,p)=>s+(Number(p.shares)||0),0);
    const unmatchedDownShares=activePositions.filter(p=>p.side==='DOWN').reduce((s,p)=>s+(Number(p.shares)||0),0);
    const mergeStatus={marketId:this.market?.id||null,lotShares:cfg.MERGE_LOT_SHARES,upShares:unmatchedUpShares,downShares:unmatchedDownShares,totalUnmatchedShares:unmatchedUpShares+unmatchedDownShares,pairableShares:Math.floor(Math.min(unmatchedUpShares,unmatchedDownShares)/cfg.MERGE_LOT_SHARES)*cfg.MERGE_LOT_SHARES};
    return {now,mode:'DEMO ONLY',status:this.status,error:this.error,mergeStatus,
          strategy:{timeframe:this.timeframe,market:'Polymarket BTC 5-minute UP/DOWN',capital:this.capital,
            entries:{orderType:'LIMIT',checkIntervalSeconds:cfg.ENTRY_CHECK_INTERVAL_MS/1000,baseShares:cfg.BASE_ENTRY_SHARES,sideIndependent:true,priceReference:'midpoint',limitOffset:cfg.LIMIT_PRICE_OFFSET,entryWindowSeconds:this.windowMs/1000,entry:'Every 5 seconds, independently place 50-share UP and DOWN limit buys at each side midpoint minus $0.05',fill:'A limit fills only after a later fresh best ask walks down to or through its limit',unfilled:'Unfilled orders expire at the five-minute window close'},
            merge:{enabled:true,lotShares:cfg.MERGE_LOT_SHARES,rule:'Merge each matched 50-share UP + 50-share DOWN complete set into 50 pUSD; leave unmatched shares open',execution:'PAPER SIMULATION ONLY'},
           exit:'A fresh own-side best bid >= $0.99 or <= $0.01 completes the window and sells all remaining positions at their own bids, less applicable taker fees (or $0 if no bid); unresolved shares close at the next window start. No official results are used.',
              direction:'UP and DOWN are accumulated independently at midpoint minus $0.05',
            entryFillModel:'Paper limit buys are priced five cents below each side midpoint; fill is confirmed when a later fresh best ask walks down to or through the limit',
            fees:'Maker fills have zero fees. Crypto rebate estimates use the published fee-equivalent weight and 20% pool rate; actual daily rebates depend on market-wide maker activity.',
          execution:'PAPER ONLY'},
         account:{capital:this.capital,cash:this.cash,realizedPnl,mergeRealizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,estimatedMakerRebate,makerFeeEquivalent,
         totalTrades,settledTrades,wins,losses,profitableExits,losingExits,breakEvenExits,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
         mergedSets:this.mergeEvents.length,mergedShares:this.mergeEvents.reduce((s,e)=>s+e.shares,0),
         mergeProceeds:this.mergeEvents.reduce((s,e)=>s+e.proceeds,0),mergeCostBasis,mergeRealizedPnl,
         openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT').length,
         maxConsecutiveLosses,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
          wins,losses,equityCurve},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
        scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
          source:'Polymarket market discovery and UP/DOWN CLOB order books only',
           marketResolution:'No official results are used; thresholds complete the window, and remaining paper shares close at own-side bids or $0 on rollover'},
        positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),
        merges:this.mergeEvents.slice(0,100),events:this.events};
  }
    start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,note:'Paper-only BTC 5m independent UP/DOWN limit buys with matched-set merges; no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={simulateAtBestAsk,feeFor,makerRebateFor,quoteFromBook,takeProfitHit,stopLossHit};
