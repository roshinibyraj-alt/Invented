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
function payout(m,side){
  const outcomes=Array.isArray(m.outcomes)?m.outcomes:parse(m.outcomes);
  const prices=Array.isArray(m.outcomePrices)?m.outcomePrices:parse(m.outcomePrices);
  const idx=outcomes.findIndex(x=>String(typeof x==='string'?x:x.name||x.label).toUpperCase()===side);
  const status=String(m.status||'').toUpperCase();
  if(!(m.closed===true||m.resolved===true||['CLOSED','RESOLVED','SETTLED'].includes(status))||idx<0)return null;
  const p=Number(prices[idx]??(typeof outcomes[idx]==='object'?outcomes[idx].payout:NaN));
  return p>=.99?1:p<=.01?0:null;
}
function parse(x){if(typeof x==='string'){try{return JSON.parse(x)}catch(_){}}return []}
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
function takeProfitHit(q,now=Date.now()){return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&clobQuotePrices(q).some(price=>price>=.99)}
function stopLossHit(q,now=Date.now()){return q&&Number.isFinite(q.updatedAt)&&now-q.updatedAt<=5000&&clobQuotePrices(q).some(price=>price<=.01)}
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
    this.positions=[];this.events=[];this.status='starting';
    this.error=null;this.market=null;this.lastMarketAt=0;
    this.lastScanAt=null;this.orders=[];this.windowOrders=[];this.orderWindowStart=null;this.running=false;
    this.quoteWindowStart=null;this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
    this.closeQuotes=null;
  }
  log(event,data={}){const e={ts:Date.now(),timeframe:this.timeframe,event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
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
      if(this.orderWindowStart!==start)this.openLadder(start,now);
      this.processLadderOrders(start,now);
      if(now>=start+this.windowMs-3000&&now<start+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===start&&(p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT'))p.closeQuotes=this.closeQuotes;
      }
      this.lastScanAt=now;this.error=null;
      for(const p of this.positions){
        if((p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT')
          &&now>=p.windowStart+this.windowMs
          &&now-(p.lastSettlementAttempt||0)>=1000) await this.trySettle(p);
      }
      const hasOpen=this.positions.some(p=>p.windowStart===start&&p.status==='OPEN');
      const hasResting=this.windowOrders.some(o=>o.status==='RESTING');
      this.status=hasOpen?'position_open':hasResting?'orders_resting':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
  }
  openLadder(start,now){
    this.orderWindowStart=start;
    const orders=[];
    for(const side of ['UP','DOWN'])for(const price of cfg.LADDER_PRICES){
      orders.push({id:`${this.timeframe}-${start}-${side}-${Math.round(price*100)}`,
        timeframe:this.timeframe,windowStart:start,side,limitPrice:price,
        shares:cfg.LADDER_SHARES,status:'RESTING',submittedAt:now});
    }
    this.windowOrders=orders;
    this.orders.unshift(...orders);
    if(this.orders.length>1000)this.orders.length=1000;
    this.log('PAPER_LIMIT_LADDER_PLACED',{windowStart:start,orders:orders.length,
      perSide:cfg.LADDER_PRICES.length,prices:cfg.LADDER_PRICES,sharesPerOrder:cfg.LADDER_SHARES,
      cancelAfterSeconds:cfg.ORDER_CANCEL_AFTER_MS/1000});
  }
  processLadderOrders(start,now){
    for(const order of this.windowOrders){
      if(order.status!=='RESTING')continue;
      if(now>=start+cfg.ORDER_CANCEL_AFTER_MS){
        order.status='CANCELLED_UNFILLED';order.cancelledAt=now;
        this.log('PAPER_LIMIT_ORDER_CANCELLED',{id:order.id,side:order.side,limitPrice:order.limitPrice,
          shares:order.shares,note:'Unfilled resting order cancelled at the 3-minute cutoff.'});
        continue;
      }
      const quote=this.liveQuotes[order.side];
      if(!quote||quote.status!=='LIVE'||now-(quote.updatedAt||0)>5000
        ||quote.bestAsk==null||quote.bestAsk>order.limitPrice)continue;
      const fillPrice=order.limitPrice,fee=feeFor(this.market,fillPrice,order.shares);
      const cost=fillPrice*order.shares,totalCost=cost+fee;
      if(totalCost>this.cash+1e-9){
        order.status='REJECTED_INSUFFICIENT_CASH';order.cancelledAt=now;
        this.log('PAPER_LIMIT_ORDER_REJECTED',{id:order.id,side:order.side,limitPrice:fillPrice,
          shares:order.shares,note:'Insufficient paper cash for this limit-order fill.'});
        continue;
      }
      const position={id:order.id,timeframe:this.timeframe,windowMs:this.windowMs,windowStart:start,
        marketId:this.market.id,slug:this.market.slug,title:this.market.title,side:order.side,
        tokenId:this.market.tokens[order.side],entryKey:order.id,entryLabel:`Limit ${usdPrice(fillPrice)}`,
        entryType:'CLOB_LIMIT_LADDER',orderType:'LIMIT',fillModel:'PAPER_LIMIT_AT_RUNG',
        shares:order.shares,initialShares:order.shares,avgEntry:fillPrice,cost,totalCost,fees:fee,
        status:'OPEN',submittedAt:order.submittedAt,openedAt:now,filledAt:now,
        visibleAskSize:quote.askSize,simulatedShares:Math.max(0,order.shares-(quote.askSize||0))};
      order.status='FILLED';order.filledAt=now;order.positionId=position.id;order.fillPrice=fillPrice;
      this.cash-=totalCost;this.positions.unshift(position);
      this.log('PAPER_LIMIT_ORDER_FILLED',{id:order.id,side:order.side,limitPrice:fillPrice,
        shares:order.shares,fee,totalCost,visibleAskSize:quote.askSize});
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
    const open=this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT');
    for(const p of open){
      if(p.windowStart===this.market.start){
        const q=this.liveQuotes[p.side];
        p.markBid=q?.bestBid??null;p.markUpdatedAt=q?.updatedAt||now;p.markStatus=q?.bestBid!=null?'LIVE':'MISSING';
        if(p.status==='OPEN'){
          if(takeProfitHit(q,now))this.finalizePosition(p,true,'TP_HIT_0_99',clobQuoteValue(q));
          else if(stopLossHit(q,now))this.finalizePosition(p,false,'STOP_LOSS_HIT_0_01',clobQuoteFloor(q));
        }
      }
    }
    const due=open.filter(p=>p.windowStart!==this.market.start&&p.tokenId&&now-(p.lastMarkAttempt||0)>=5000);
    await Promise.all(due.map(async p=>{
      p.lastMarkAttempt=now;
      try{const q=quoteFromBook(await md.getBook(p.tokenId),now);p.markBid=q.bestBid;p.markUpdatedAt=now;p.markStatus=q.bestBid!=null?'LIVE':'MISSING'}
      catch(_){p.markStatus=p.markBid!=null?'STALE':'MISSING'}
    }));
  }
  async trySettle(p){
    if(Date.now()<p.windowStart+(p.windowMs||this.windowMs))return;if(!['OPEN','PENDING_CLOB_RESULT'].includes(p.status))return;p.lastSettlementAttempt=Date.now();
    try{let market;try{market=await md.getMarket(p.marketId)}catch(_){market=await md.getBtcMarket(p.windowStart,p.windowMs||this.windowMs)}const result=payout(market,p.side);
      if(result==null){p.status='PENDING_CLOB_RESULT';p.settlementError='Waiting for Polymarket official resolution';if(!p.lastPendingLog||Date.now()-p.lastPendingLog>30000){p.lastPendingLog=Date.now();this.log('PAPER_OFFICIAL_RESULT_PENDING',{id:p.id,marketId:p.marketId})}return}
      this.finalizePosition(p,result===1,result===1?'OFFICIAL_RESOLUTION_WIN':'OFFICIAL_RESOLUTION_LOSS',null);
    }catch(e){p.status='PENDING_CLOB_RESULT';p.settlementError=e.message;if(!p.lastPendingLog||Date.now()-p.lastPendingLog>30000){p.lastPendingLog=Date.now();this.log('PAPER_OFFICIAL_RESULT_PENDING',{id:p.id,marketId:p.marketId,error:e.message})}}
  }
  finalizePosition(p,won,reason,triggerQuote){if(!['OPEN','PENDING_CLOB_RESULT'].includes(p.status))return;p.payout=won?1:0;p.proceeds=won?p.shares:0;p.realizedPnl=p.proceeds-p.totalCost;p.status=won?'SETTLED_WIN':'SETTLED_LOSS';p.settledAt=Date.now();p.settlementBasis=reason;p.tpTriggerQuote=reason==='TP_HIT_0_99'?triggerQuote:null;p.stopTriggerQuote=reason.startsWith('STOP_LOSS_HIT_')?triggerQuote:null;p.winningSide=won?p.side:null;this.cash+=p.proceeds;const event=reason==='TP_HIT_0_99'?'PAPER_TP_HIT':reason.startsWith('STOP_LOSS_HIT_')?'PAPER_STOP_LOSS':won?'PAPER_OFFICIAL_WIN':'PAPER_OFFICIAL_LOSS';this.log(event,{id:p.id,status:p.status,pnl:p.realizedPnl,side:p.side,shares:p.shares,proceeds:p.proceeds,triggerQuote,tpTarget:.99,stopLoss:p.stopLossThreshold??.01,reason})}
  snapshot(){
    const now=Date.now();
    const realizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
    const takerFees=this.positions.reduce((s,p)=>s+(p.fees||0),0);
    const wins=this.positions.filter(p=>p.status==='SETTLED_WIN').length,losses=this.positions.filter(p=>p.status==='SETTLED_LOSS').length;
    const settledTrades=wins+losses,totalTrades=this.positions.filter(p=>p.status!=='CANCELLED_UNFILLED').length;
    const history=this.positions.filter(p=>p.status==='SETTLED_WIN'||p.status==='SETTLED_LOSS')
      .sort((a,b)=>(a.settledAt||0)-(b.settledAt||0));
    const equityCurve=[{ts:this.startedAt,equity:this.capital}];
    let curveEquity=this.capital,peak=this.capital,maxDrawdown=0,maxConsecutiveLosses=0,lossStreak=0;
    for(const p of history){
      curveEquity+=Number(p.realizedPnl)||0;
      equityCurve.push({ts:p.settledAt||p.openedAt,equity:curveEquity});
      peak=Math.max(peak,curveEquity);maxDrawdown=Math.max(maxDrawdown,peak-curveEquity);
      if(p.status==='SETTLED_LOSS'){lossStreak++;maxConsecutiveLosses=Math.max(maxConsecutiveLosses,lossStreak)}
      else lossStreak=0;
    }
    let unrealizedPnl=0,unpricedOpenPositions=0,markedValue=0;
    for(const p of this.positions){
      if(p.status!=='OPEN'&&p.status!=='PENDING_CLOB_RESULT'){
        p.markValue=0;p.unrealizedPnl=0;p.markStatus='CLOSED';continue;
      }
      const mark=p.markBid==null?null:p.markBid*p.shares;p.markAgeMs=p.markUpdatedAt?Math.max(0,now-p.markUpdatedAt):null;p.markStatus=mark==null?'UNAVAILABLE':p.markAgeMs>15000?'STALE':'LIVE';const freshMark=mark!=null&&p.markAgeMs<=15000;p.markValue=freshMark?mark:null;p.unrealizedPnl=freshMark?mark-p.totalCost:null;if(!freshMark)unpricedOpenPositions++;else{markedValue+=mark;unrealizedPnl+=p.unrealizedPnl}
    }
    return {now,mode:'DEMO ONLY',status:this.status,error:this.error,
        strategy:{timeframe:this.timeframe,market:'Polymarket BTC 5-minute UP/DOWN',capital:this.capital,
          entries:{orderType:'LIMIT',prices:cfg.LADDER_PRICES,sharesPerOrder:cfg.LADDER_SHARES,
            sides:['UP','DOWN'],cancelAfterSeconds:cfg.ORDER_CANCEL_AFTER_MS/1000,
            timing:'Place both-side CLOB price ladder orders at window start; cancel unfilled orders after 3 minutes'},
          exit:'Any fresh own-side CLOB bid/ask/mid >= $0.99 immediately pays $1/share; <= $0.01 immediately pays $0/share; otherwise use official Gamma outcome at window close',
          direction:'CLOB prices only; accumulate UP and DOWN positions independently',
          entryFillModel:'Paper limit order fills at its rung when the fresh best ask reaches or crosses the limit',
          fees:'Existing crypto fee estimate is deducted from the paper ledger',
          execution:'PAPER ONLY'},
        account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,takerFees,
         totalTrades,settledTrades,wins,losses,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
         openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT').length,
         maxConsecutiveLosses,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
          wins,losses,equityCurve},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
        scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
          source:'Polymarket market discovery and UP/DOWN CLOB order books only',
          marketResolution:'Own-side fresh CLOB quote >= $0.99 settles $1/share, <= $0.01 settles $0/share immediately; otherwise official Gamma result is retried until resolved'},
       positions:this.positions.slice(0,50),orders:this.orders.slice(0,100),events:this.events};
  }
  start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,note:'Paper-only BTC 5m CLOB limit ladder on both UP and DOWN sides; no pattern signals and no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={simulateAtBestAsk,feeFor,payout,quoteFromBook,clobWinner,clobQuoteWinner,clobQuoteValue,clobQuoteFloor,takeProfitHit,stopLossHit};
