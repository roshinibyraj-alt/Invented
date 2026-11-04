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
     this.windowShares=cfg.BASE_SHARES;
     this.stakeProgression={baseShares:cfg.BASE_SHARES,shares:cfg.BASE_SHARES,
       martingaleLevel:0,lastOutcome:null};
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
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
        this.closeQuotes=null;
      }
      await this.closePreviousWindows(start,now);
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
       this.placeWindowEntryOrders(start,now);
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
        id:p.id,windowStart:p.windowStart,side:p.side,shares:p.shares,marketId:p.marketId});
    }
    for(const windowStart of previousStarts){
      this.log('PAPER_WINDOW_ROLLED_OVER',{windowStart,currentStart,closedPositions:open.filter(p=>p.windowStart===windowStart).length,
        cancelledOrders:previousOrders.filter(order=>order.windowStart===windowStart).length});
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
    this.windowStrategySide=null;
    this.windowSignalSide=null;
    this.windowEntryPlaced=false;
    this.windowEntryOrderId=null;
    this.windowTrigger=null;
    this.windowShares=this.stakeProgression.shares;
    this.log('PAPER_OCO_WINDOW_STARTED',{windowStart:start,timeframe:this.timeframe,
      shares:this.windowShares,limitPrice:cfg.ENTRY_LIMIT_PRICE});
  }
  placeWindowEntryOrders(start,now){
    if(this.completedWindows.has(start)||this.orderWindowStart!==start||this.windowEntryPlaced||
       !this.market||this.market.start!==start)return false;
    const shares=Number(this.windowShares.toFixed(6));
    const stakeUsd=Number((shares*cfg.ENTRY_LIMIT_PRICE).toFixed(6));
    this.windowEntryPlaced=true;
    this.windowTrigger={placedAt:now,limitPrice:cfg.ENTRY_LIMIT_PRICE,shares,stakeUsd};
    const cost=Number((shares*cfg.ENTRY_LIMIT_PRICE).toFixed(6));
    const unaffordable=cost>this.cash+1e-9;
    for(const side of ['UP','DOWN']){
      const quote=this.liveQuotes[side]||{};
      const id=`${this.timeframe}-${start}-${side.toLowerCase()}-oco-entry`;
      const order={id,timeframe:this.timeframe,windowStart:start,side,signalSide:side,
        tokenId:this.market.tokens[side],orderType:'LIMIT',entryMode:'DUAL_SIDE_OCO',
        entryType:'OCO_LIMIT_BUY',limitPrice:cfg.ENTRY_LIMIT_PRICE,stakeUsd,shares,
        remainingShares:shares,status:unaffordable?'REJECTED_INSUFFICIENT_CASH':'PENDING',
        createdAt:now,submittedAt:now,quoteAtSubmission:quote.updatedAt||now,
        expiresAt:start+this.windowMs,fee:0,
        estimatedMakerRebate:makerRebateFor(this.market,cfg.ENTRY_LIMIT_PRICE,shares).estimate,
        fillModel:'PAPER_RESTING_LIMIT_ASK_AT_OR_BELOW_LIMIT',
        progressionLevel:this.stakeProgression.martingaleLevel};
      if(unaffordable){
        order.remainingShares=0;
        order.reason='The current progression size exceeds available paper cash.';
      }
      this.totalOrderAttempts++;
      this.windowOrders.push(order);this.orders.unshift(order);
    }
    if(this.orders.length>1000)this.orders.length=1000;
    this.windowEntryOrderId=this.windowOrders[0]?.id||null;
    if(unaffordable){
      this.log('PAPER_OCO_ORDERS_REJECTED',{windowStart:start,shares,cost,cash:this.cash});
      return false;
    }
    this.log('PAPER_OCO_LIMIT_ORDERS_PLACED',{windowStart:start,limitPrice:cfg.ENTRY_LIMIT_PRICE,
      shares,upOrderId:this.windowOrders[0].id,downOrderId:this.windowOrders[1].id});
    return true;
  }
  updateStakeProgressionAfterClose(position){
    if(position.progressionApplied)return;
    position.progressionApplied=true;
    const pnl=Number(position.realizedPnl)||0,progress=this.stakeProgression;
    if(pnl>1e-9){
      progress.shares=progress.baseShares;
      progress.martingaleLevel=0;progress.lastOutcome='WIN';
    }else if(pnl < -1e-9){
      progress.lastOutcome='LOSS';
      if(Number(position.progressionLevel)<cfg.MAX_MULTIPLIER_LEVELS){
        progress.martingaleLevel=Number(position.progressionLevel)+1;
        progress.shares=Number((progress.baseShares*Math.pow(cfg.LOSS_MULTIPLIER,
          progress.martingaleLevel)).toFixed(6));
      }else{
        progress.martingaleLevel=0;
        progress.shares=progress.baseShares;
      }
    }else progress.lastOutcome='BREAKEVEN';
    this.log('PAPER_STAKE_PROGRESSION_UPDATED',{positionId:position.id,pnl,
      baseShares:progress.baseShares,nextShares:progress.shares,
      martingaleLevel:progress.martingaleLevel,lastOutcome:progress.lastOutcome});
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
    }
    if(!this.market)return;
    const candidates=this.orders.filter(order=>order.status==='PENDING'&&
      order.windowStart===this.market.start&&this.market.start===this.orderWindowStart)
      .map(order=>{
      const quote=this.liveQuotes[order.side],ask=Number(quote?.bestAsk);
      const fresh=quote?.status==='LIVE'&&Number.isFinite(quote.updatedAt)
        &&now-quote.updatedAt<=5000&&quote.updatedAt>order.quoteAtSubmission&&Number.isFinite(ask);
      return fresh&&ask>0&&ask<=order.limitPrice+1e-9?{order,quote,ask}:null;
    }).filter(Boolean).sort((a,b)=>a.ask-b.ask||a.order.side.localeCompare(b.order.side));
    const candidate=candidates[0];
    if(!candidate)return;
    const {order,quote,ask}=candidate;
    const shares=Number((order.remainingShares||order.shares).toFixed(6));
    const fillPrice=Math.min(order.limitPrice,ask);
    const cost=Number((fillPrice*shares).toFixed(6));
    const maker=makerRebateFor(this.market,order.limitPrice,shares);
    if(cost>this.cash+1e-9){
      for(const sibling of this.orders.filter(item=>item.windowStart===order.windowStart&&item.status==='PENDING')){
        sibling.status='REJECTED_INSUFFICIENT_CASH';
        sibling.reason='Cash was no longer available when the limit price was crossed.';
        sibling.remainingShares=0;
      }
      return;
    }
    this.cancelOcoSiblings(order,now);
    const position={id:order.id,timeframe:this.timeframe,windowMs:this.windowMs,
      windowStart:order.windowStart,marketId:this.market.id,slug:this.market.slug,
      title:this.market.title,side:order.side,tokenId:this.market.tokens[order.side],
      entryKey:order.id,entryLabel:`${order.side} limit buy ${usdPrice(fillPrice)} · ${shares} shares`,
      entryMode:order.entryMode,entryType:order.entryType,
      stakeUsd:order.stakeUsd,progressionLevel:order.progressionLevel,
      takeProfitThreshold:cfg.TAKE_PROFIT_PRICE,
      limitPrice:order.limitPrice,orderType:'LIMIT',fillModel:order.fillModel,
      shares,initialShares:shares,avgEntry:fillPrice,fillPrice,cost,totalCost:cost,fees:0,
      makerFeeEquivalent:maker.feeEquivalent,estimatedMakerRebate:maker.estimate,
      status:'OPEN',submittedAt:order.submittedAt,openedAt:now,filledAt:now,
      visibleAskSize:quote.askSize,simulatedShares:shares,
      entryQuotes:this.captureQuotePair(now),entryQuoteAt:now,
      feeContext:feeContext(this.market)};
    order.status='FILLED';order.filledAt=now;order.positionId=order.id;
    order.fillPrice=fillPrice;order.fee=0;order.feeEquivalent=maker.feeEquivalent;
    order.estimatedMakerRebate=maker.estimate;order.remainingShares=0;
    this.windowSignalSide=order.side;
    this.windowStrategySide=order.side;
    this.windowTrigger={...this.windowTrigger,side:order.side,fillPrice,filledAt:now};
    this.cash-=cost;this.positions.unshift(position);
    this.log('PAPER_LIMIT_ORDER_FILLED',{id:order.id,side:order.side,limitPrice:order.limitPrice,
      fillPrice,walkedAsk:ask,shares,fee:0,feeEquivalent:maker.feeEquivalent,
      estimatedMakerRebate:maker.estimate,totalCost:cost,oppositeOrderCancelled:true});
  }
  cancelOcoSiblings(filledOrder,now){
    for(const sibling of this.orders){
      if(sibling.windowStart!==filledOrder.windowStart||sibling.id===filledOrder.id||
         !['PENDING','LIVE','MARKET_PENDING'].includes(sibling.status))continue;
      sibling.status='CANCELLED_OCO';
      sibling.cancelledAt=now;
      sibling.remainingShares=0;
      sibling.cancelReason='Opposite-side order cancelled after first fill.';
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
        if(p.status==='OPEN'&&takeProfitHit(q,now))
          await this.completeWindow(p.windowStart,p,true,'TAKE_PROFIT_BID',Number(q.bestBid),now);
      }
    }
  }
  finalizePosition(p,won,reason,triggerQuote,settledAt=Date.now()){
    if(p.status!=='OPEN'||reason!=='TAKE_PROFIT_BID')return;
    const exitPrice=Number.isFinite(Number(triggerQuote))?Math.max(0,Math.min(1,Number(triggerQuote))):null;
    p.payout=cfg.TAKE_PROFIT_PAYOUT_PER_SHARE;
    p.proceeds=p.shares*cfg.TAKE_PROFIT_PAYOUT_PER_SHARE;
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost-p.exitFees;
    p.status='SETTLED_EXIT';
    p.settledAt=settledAt;
    p.settlementBasis=reason;
    p.exitReason=reason;
    p.tpTriggerQuote=triggerQuote;
    p.exitBid=exitPrice;
    p.exitType='LIMIT';
    this.captureExitQuotes(p,settledAt,p.exitBid,p.exitBid!=null);
    this.cash+=p.proceeds-p.exitFees;
    this.log('PAPER_TP_HIT',{id:p.id,status:p.status,pnl:p.realizedPnl,side:p.side,shares:p.shares,
      proceeds:p.proceeds,exitFees:p.exitFees,triggerQuote,tpTarget:cfg.TAKE_PROFIT_PRICE});
    this.updateStakeProgressionAfterClose(p);
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
    this.updateStakeProgressionAfterClose(p);
    return true;
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
    for(const p of open){
      if(p.status!=='OPEN')continue;
      if(p===triggerPosition&&triggerReason==='TAKE_PROFIT_BID'){
        this.finalizePosition(p,triggerWon,triggerReason,triggerQuote,now);
      }else{
        p.status='PENDING_RESOLUTION';
        p.pendingResolutionSince=now;
        p.markStatus='PENDING_RESOLUTION';
        p.markValue=null;
        p.unrealizedPnl=null;
      }
    }
    this.log('PAPER_WINDOW_COMPLETED',{windowStart,reason:triggerReason,closedPositions:open.length});
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
    const equityCurve=[{ts:this.startedAt,equity:this.capital}];
     let curveEquity=this.capital,peak=this.capital,maxDrawdown=0;
     let maxConsecutiveLosses=0,maxConsecutiveWins=0,lossStreak=0,winStreak=0;
    for(const p of history){
      curveEquity+=Number(p.realizedPnl)||0;
      equityCurve.push({ts:p.settledAt||p.openedAt,equity:curveEquity});
      peak=Math.max(peak,curveEquity);maxDrawdown=Math.max(maxDrawdown,peak-curveEquity);
       const pnl=Number(p.realizedPnl)||0;
       if(pnl<0){
         lossStreak++;winStreak=0;
         maxConsecutiveLosses=Math.max(maxConsecutiveLosses,lossStreak);
       }else if(pnl>0){
         winStreak++;lossStreak=0;
         maxConsecutiveWins=Math.max(maxConsecutiveWins,winStreak);
       }else{
         lossStreak=0;winStreak=0;
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
       return {now,mode:'DEMO ONLY',status:this.status,error:this.error,
          strategy:{timeframe:this.timeframe,market:'Polymarket BTC 5-minute UP/DOWN',capital:this.capital,
             entries:{orderType:'LIMIT',sideIndependent:true,side:this.windowStrategySide,
              signalSide:this.windowSignalSide,signal:{side:this.windowSignalSide,
                 reason:this.windowEntryPlaced
                   ?`UP and DOWN resting limit buys placed at ${usdPrice(cfg.ENTRY_LIMIT_PRICE)}; first fill cancels the other.`
                   :'Waiting for the current BTC 5-minute market window.',
                 limitPrice:cfg.ENTRY_LIMIT_PRICE,
                 ready:this.windowEntryPlaced},
               waitSeconds:0,limitPrice:cfg.ENTRY_LIMIT_PRICE,
               stakeUsd:this.windowTrigger?.stakeUsd??Number((this.stakeProgression.shares*cfg.ENTRY_LIMIT_PRICE).toFixed(6)),
               shares:this.windowTrigger?.shares??this.stakeProgression.shares,
               entryPlaced:this.windowEntryPlaced,
              unfilledCarryover:true,progression:{...this.stakeProgression}},
             exit:{takeProfitPrice:cfg.TAKE_PROFIT_PRICE,
              takeProfitPayoutPerShare:cfg.TAKE_PROFIT_PAYOUT_PER_SHARE,
               windowEnd:'Cancel unfilled buys; hold filled shares for Polymarket market resolution.'},
             timing:'At window start, place $0.25 resting limit buys for the current share size on both UP and DOWN.',
             fill:'The first newer fresh ask at or below $0.25 fills; immediately cancel the opposite-side order.',
             unfilled:'Unfilled buys expire at window end without changing the progression.',
             fees:'Limit buys and $0.99 take-profit limits use the paper maker-fee model; resolution payouts have no exit fee.',
            execution:'PAPER ONLY'},
         account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,estimatedMakerRebate,
          totalTrades,settledTrades,wins,losses,profitableExits,losingExits,breakEvenExits,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
           openPositions:this.positions.filter(p=>['OPEN','PENDING_RESOLUTION'].includes(p.status)).length,
          maxConsecutiveLosses,maxConsecutiveWins,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
          wins,losses,equityCurve},
       window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end,
         complete:this.completedWindows.has(this.market.start),completionReason:this.completedWindows.get(this.market.start)?.reason||null}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
        scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
            source:'Polymarket BTC 5-minute Gamma/CLOB order books',
             marketResolution:'A fresh best bid at $0.99 triggers a $1/share take-profit. Otherwise, filled shares remain held until the official Polymarket market result is available.'},
       inventory,positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
        start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,
         note:'Paper-only BTC 5-minute OCO strategy: paired $0.25 limit buys, first fill cancels the opposite side, no stop-loss.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={quoteFromBook,takerFeeFor,makerRebateFor,takeProfitHit};
