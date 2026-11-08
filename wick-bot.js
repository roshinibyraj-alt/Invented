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
    strategyId='btc-5m-signal',strategyName='57-second BTC signal limit strategy',rules={}}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.strategyId=strategyId;this.strategyName=strategyName;
    this.rules={entryLimitPrice:cfg.ENTRY_LIMIT_PRICE,
      sharesPerSide:cfg.ENTRY_SHARES,
      signalScanLeadMs:cfg.SIGNAL_SCAN_LEAD_MS,
      signalCompareLeadMs:cfg.SIGNAL_COMPARE_LEAD_MS,...rules};
    this.startedAt=Date.now();
    this.positions=[];this.events=[];this.status='starting';this.completedWindows=new Map();
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.totalOrderAttempts=0;
    this.windowOrders=[];this.orderWindowStart=null;this.running=false;
    this.entryTriggerLatched=false;this.entryTriggerAt=null;this.entryTriggerSide=null;
    this.entryTriggerCandle=null;
    this.entryTriggerReason=null;this.entryOrderPlaced=false;this.entryOrderId=null;
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
      this.processStrategyEntry(now);
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
    const previousOrders=this.orders.filter(order=>order.action==='BUY'&&
      ['PENDING','LIVE','MARKET_PENDING','PARTIALLY_FILLED'].includes(order.status)&&
      Number(order.windowStart)+this.windowMs<=currentStart);
    const open=this.positions.filter(p=>p.status==='OPEN'&&Number(p.windowStart)+this.windowMs<=currentStart);
    if(!previousOrders.length&&!open.length)return 0;
    for(const order of previousOrders){
      order.status='CANCELLED_WINDOW_END';
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
    this.entryTriggerReason=null;
    this.entryOrderPlaced=false;
    this.entryOrderId=null;
    this.entryAttemptMissed=false;
    this.log('PAPER_STRATEGY_WINDOW_STARTED',{windowStart:start,timeframe:this.timeframe,
      strategyId:this.strategyId,strategyName:this.strategyName,windowMs:this.windowMs,
      signalScanLeadMs:this.rules.signalScanLeadMs,
      signalCompareLeadMs:this.rules.signalCompareLeadMs,
      entryLimitPrice:this.rules.entryLimitPrice,
      shares:this.rules.sharesPerSide});
  }
  processStrategyEntry(){return false}
  recordStrategyOutcome(position,outcome,now=Date.now(),reason=outcome){
    if(position.strategyOutcomeApplied)return;
    if(!['WIN','LOSS','BREAK_EVEN'].includes(outcome))return;
    position.strategyOutcomeApplied=true;
    position.strategyOutcome=outcome;
    position.strategyOutcomeAt=now;
    position.strategyOutcomeReason=reason;
    this.log('PAPER_POSITION_OUTCOME_RECORDED',{positionId:position.id,outcome,reason});
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
  }
  finalizeResolution(p,winner,now=Date.now()){
    if(p.status!=='PENDING_RESOLUTION')return false;
    const won=p.side===winner;
    p.payout=won?1:0;
    p.proceeds=p.shares*p.payout;
    p.exitFees=0;
    p.realizedPnl=p.proceeds-p.totalCost+(p.estimatedMakerRebate||0);
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
      const mark=p.markBid==null?null:p.markBid*p.shares;p.markAgeMs=p.markUpdatedAt?Math.max(0,now-p.markUpdatedAt):null;p.markStatus=mark==null?'UNAVAILABLE':p.markAgeMs>15000?'STALE':'LIVE';const freshMark=mark!=null&&p.markAgeMs<=15000;p.markValue=freshMark?mark:null;p.unrealizedPnl=freshMark?mark-p.totalCost+(p.estimatedMakerRebate||0):null;if(!freshMark)unpricedOpenPositions++;else{markedValue+=mark;unrealizedPnl+=p.unrealizedPnl}
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
          const currentEntryWindow=!!this.market&&
            elapsedMs>=-this.rules.signalScanLeadMs&&elapsedMs<this.windowMs;
        const safeQuotes=this.captureQuotePair(now);
        const entryOrder=this.entryOrderId?this.orders.find(order=>order.id===this.entryOrderId):null;
        const orderStatus=entryOrder?.status||'NOT_PLACED';
        const signalReason=this.entryTriggerReason||
          (entryOrder?`$${this.rules.entryLimitPrice.toFixed(2)} limit buy ${orderStatus.toLowerCase()} on ${entryOrder.side}.`:
            this.entryAttemptMissed?'The candle signal or entry order was missed for this window.':
            this.entryTriggerLatched?'Candle signal ready; waiting for the window to open.':
            currentEntryWindow?'Waiting for the final-segment BTC comparison.':
            'Waiting for the final 10 seconds before the next window.');
        return {now,mode:'DEMO ONLY',status:this.status,error:this.error,
             strategy:{id:this.strategyId,name:this.strategyName,timeframe:this.timeframe,
               market:'Polymarket BTC 5-minute UP/DOWN',
              capital:this.capital,execution:'PAPER ONLY',
              entries:{orderType:'LIMIT',
                   sideSelection:'Final 57-second BTC move versus the previous closed one-minute candle: higher UP; otherwise DOWN.',
                  sharesPerSide:this.rules.sharesPerSide,
                  limitPrice:this.rules.entryLimitPrice,
                   fillPolicy:'Better-price asks only if present at submission; later resting fills at limit price.',
                  signalScanSecondsBeforeWindow:this.rules.signalScanLeadMs/1000,
                  signalCompareSecondsBeforeWindow:this.rules.signalCompareLeadMs/1000,
                  triggerPriceSource:'live BTC price versus previous closed one-minute candle close',
                 triggerLatched:this.entryTriggerLatched,triggerAt:this.entryTriggerAt,
                  triggerSide:this.entryTriggerSide,
                  orderPlaced:!!entryOrder,orderStatus,filledShares:entryOrder?.filledShares||0,
                  remainingShares:entryOrder?.remainingShares??this.rules.sharesPerSide,
                  attemptMissed:this.entryAttemptMissed===true,
                  signal:{side:this.entryTriggerSide,
                    tradeSide:this.entryTriggerSide==='UP'?'DOWN':this.entryTriggerSide==='DOWN'?'UP':null,
                    reason:signalReason,
                    candle:this.entryTriggerCandle,ready:this.entryTriggerLatched}},
                exit:{orderType:'POLYMARKET_RESOLUTION_ONLY',takeProfit:null,stopLoss:null,
                 windowEnd:'Hold filled positions through the window; settle only from the original market’s confirmed Polymarket resolution.'},
                 timing:'Compare BTC at T−3 seconds with the previous closed 1-minute candle; at window open, buy the opposite side of that signal.',
                 sizing:`${this.rules.sharesPerSide} shares on the side opposite the signal at a $${this.rules.entryLimitPrice.toFixed(2)} limit.`,
                 trigger:'At T−3s, compare BTC with the previous closed 1-minute candle close: higher is green/UP; equal or lower is red/DOWN. This represents the final 57 seconds.',
                 fillPolicy:`At submission, fresh asks below $${this.rules.entryLimitPrice.toFixed(2)} may fill at their lower price. If the order rests first, later fills book at $${this.rules.entryLimitPrice.toFixed(2)}. Never above the limit.`,
                  unfilled:`Only fresh, newly observed ask depth at or below $${this.rules.entryLimitPrice.toFixed(2)} can match. Asks already below the limit at submission may fill at that lower price; later fills of a resting order book at the limit price. No timeout fill is used; unmatched entry shares are cancelled at window end. Filled shares remain open until the original market’s official Polymarket resolution.`,
                 fees:'Limit entry fills have no taker fee; estimated maker rebates are applied to entry fills only.',
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
                 marketResolution:'Every filled position waits for the official resolution of its original Polymarket market.'},
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
module.exports._test={quoteFromBook,takerFeeFor,makerRebateFor,feeContext};
