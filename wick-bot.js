'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');
const {detectTimedStrategy,aggregate}=require('./wick-core');

function levels(xs){return (xs||[]).map(x=>({price:Number(x.price),size:Number(x.size)}))
  .filter(x=>Number.isFinite(x.price)&&x.size>0).sort((a,b)=>a.price-b.price)}
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
  const rate=Number(m.feeSchedule?.rate??m.takerFeeRate??cfg.FEE_RATE);
  const exp=Number(m.feeSchedule?.exponent??1);
  return rate*Math.pow(avg*(1-avg),exp)*qty;
}
function clobWinner(up,down){
  if(!Number.isFinite(up)||!Number.isFinite(down))return null;
  return up>=.98?'UP':down>=.98?'DOWN':up>=down?'UP':'DOWN';
}
function clobQuotePrices(q){
  return [q?.mid,q?.bestBid,q?.bestAsk].map(Number).filter(x=>Number.isFinite(x)&&x>=0&&x<=1);
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
  constructor({timeframe='5m',windowMs=cfg.WINDOW_MS,capital=cfg.DEMO_CAPITAL_5M}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.startedAt=Date.now();
    this.positions=[];this.events=[];this.status='starting';
    this.error=null;this.market=null;this.candles=[];this.lastMarketAt=0;
    this.lastCandlesAt=0;this.lastScanAt=null;this.entryState={};this.running=false;
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
      if(!this.candles.length||now-this.lastCandlesAt>cfg.CANDLE_REFRESH_MS){
        this.candles=await md.getMinuteCandles();this.lastCandlesAt=now;
      }
      await this.refreshLiveQuotes(now);
      if(now>=start+this.windowMs-3000&&now<start+this.windowMs){
        this.closeQuotes={UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN,ts:now};
        for(const p of this.positions)if(p.windowStart===start&&(p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT'))p.closeQuotes=this.closeQuotes;
      }
      const analysis=detectTimedStrategy({minuteCandles:this.candles,windowStart:start,windowMs:this.windowMs,now,
        entryShares:this.nextEntryShares()});
      this.analysis=analysis;this.lastScanAt=now;this.error=null;
      for(const p of this.positions){
        if((p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT')
          &&now>=p.windowStart+this.windowMs
          &&now-(p.lastSettlementAttempt||0)>=1000) await this.trySettle(p);
      }
      if(analysis.ready){
        const state=this.entryState[start]||(this.entryState[start]={triggered:{},filled:{},blocks:{}});
        for(const entry of analysis.entries){
          const key=entry.key,trigger=state.triggered[key];
          if(entry.crossed&&!trigger){
            state.triggered[key]={...entry,triggeredAt:now};
            this.log('PATTERN_ENTRY_TRIGGER',{side:entry.side,entry:key,label:entry.label,
              shares:entry.shares,pattern:entry.pattern,signalStrength:entry.signalStrength,
              observedPrice:entry.observedPrice});
          }
          const saved=state.triggered[key];
          if(saved&&!state.filled[key]){
            if(now<saved.windowEnd&&now-start<cfg.ENTRY_CUTOFF_MS)await this.tryEnter(start,saved,key);
            else if(!state.expired?.[key]){
              state.expired=state.expired||{};state.expired[key]=true;
              this.log('PATTERN_ENTRY_EXPIRED',{entry:key,side:saved.side,shares:saved.shares,note:'270-second entry cutoff reached before a paper fill'});
            }
          }
          entry.triggered=Boolean(saved);entry.filled=Boolean(state.filled[key]);
          entry.expired=Boolean(state.expired?.[key]||entry.expired);entry.block=state.blocks[key]||null;
        }
      }
      const hasOpen=this.positions.some(p=>p.windowStart===start&&p.status==='OPEN');
      this.status=hasOpen?'position_open':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
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
  nextEntryShares(){
    let shares=cfg.ENTRY_FLOOR_SHARES;
    const settled=this.positions.filter(p=>p.status==='SETTLED_WIN'||p.status==='SETTLED_LOSS')
      .sort((a,b)=>(a.settledAt||0)-(b.settledAt||0));
    for(const p of settled)shares=p.status==='SETTLED_LOSS'
      ?Math.min(cfg.ENTRY_MAX_SHARES,shares+cfg.ENTRY_SIZE_STEP_SHARES)
      :Math.max(cfg.ENTRY_FLOOR_SHARES,shares-cfg.ENTRY_SIZE_STEP_SHARES);
    return shares;
  }
  async tryEnter(start,trigger,key){
    const now=Date.now();
    if(now<start+cfg.ENTRY_DELAY_MS||now>=trigger.windowEnd||now-start>=cfg.ENTRY_CUTOFF_MS)return;
    const state=this.entryState[start];
    if(state.filled[key])return;
    const token=this.market.tokens[trigger.side],book=await md.getBook(token);
    const fill=simulateAtBestAsk(book.asks,trigger.shares,cfg.MAX_ENTRY_ASK,cfg.MIN_ENTRY_ASK);
    if(!fill){state.blocks[key]=`Waiting for signaled-side best ask below ${cfg.MAX_ENTRY_ASK.toFixed(2)} (and at least ${cfg.MIN_ENTRY_ASK.toFixed(2)})`;return}
    const fee=feeFor(this.market.raw,fill.avg,fill.shares),total=fill.cost+fee;
    if(total>this.cash){state.blocks[key]='Insufficient demo cash';return}
    const p={id:`${this.timeframe}-${start}-${trigger.side}-${key}`,timeframe:this.timeframe,
       windowMs:this.windowMs,windowStart:start,marketId:this.market.id,slug:this.market.slug,
      title:this.market.title,side:trigger.side,tokenId:token,entryKey:key,entryLabel:trigger.label,
        entryType:'CANDLE_PATTERN_SINGLE_ENTRY',
        signalPattern:trigger.pattern||null,signalStrength:trigger.signalStrength||0,
       shares:fill.shares,initialShares:fill.shares,
       oppositeTokenId:this.market.tokens[trigger.side==='UP'?'DOWN':'UP'],
        avgEntry:fill.avg,cost:fill.cost,fees:fee,totalCost:total,status:'OPEN',openedAt:Date.now(),
        fillModel:'FULL_SIZE_AT_BEST_ASK',visibleAskSize:fill.visibleDepth,simulatedShares:fill.simulatedShares,
         observedPrice:trigger.observedPrice};
     this.cash-=total;this.positions.unshift(p);state.filled[key]=p.id;delete state.blocks[key];this.status='position_open';
     this.log('PAPER_CANDLE_PATTERN_ENTRY',{timeframe:this.timeframe,id:p.id,side:p.side,entry:key,label:p.entryLabel,
       pattern:p.signalPattern,signalStrength:p.signalStrength,shares:p.shares,entryPrice:p.avgEntry,avgEntry:p.avgEntry,cost:p.totalCost,
      fillModel:p.fillModel,visibleAskSize:p.visibleAskSize,simulatedShares:p.simulatedShares});
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
    const prior=this.market?aggregate(this.candles,this.windowMs)
      .filter(x=>x.t<this.market.start).slice(-3):[];
    const now=Date.now();
    const realizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
    const wins=this.positions.filter(p=>p.status==='SETTLED_WIN').length,losses=this.positions.filter(p=>p.status==='SETTLED_LOSS').length;
    const settledTrades=wins+losses,totalTrades=this.positions.length;
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
        strategy:{timeframe:'5m',market:'Polymarket BTC 5-minute UP/DOWN',capital:this.capital,
          entries:[{shares:this.nextEntryShares(),trigger:'candle pattern + MACD confirmation',
            floorShares:cfg.ENTRY_FLOOR_SHARES,maxShares:cfg.ENTRY_MAX_SHARES,
            stepShares:cfg.ENTRY_SIZE_STEP_SHARES,delaySeconds:cfg.ENTRY_DELAY_MS/1000,
            timing:'single paper entry per window; resize after each settled result'}],
          exit:'Any fresh own-side CLOB bid/ask/mid >= $0.99 immediately pays $1/share; <= $0.01 immediately pays $0/share; otherwise use official Gamma outcome at window close',
          minEntryAsk:cfg.MIN_ENTRY_ASK,maxEntryAsk:cfg.MAX_ENTRY_ASK,
          direction:'A completed five-minute candle pattern must agree with MACD 12/26/9 on completed one-minute BTC bars' ,
          entryCutoffSeconds:cfg.ENTRY_CUTOFF_MS/1000,entryDelaySeconds:cfg.ENTRY_DELAY_MS/1000,
          entryFillModel:'Wait for the signaled-side best ask below $0.49, then fill full size; minimum ask $0.05',
          fees:'Polymarket taker fees on simulated buys',execution:'PAPER ONLY'},
       account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,
         totalTrades,settledTrades,wins,losses,winRate:settledTrades?wins/settledTrades*100:0,markedValue,unpricedOpenPositions,
         openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_CLOB_RESULT').length,
         maxConsecutiveLosses,maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
         wins,losses,equityCurve,nextEntryShares:this.nextEntryShares()},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
       scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,
             candleSource:`Polymarket RTDS Chainlink BTC/USD; one-minute candles aggregated into completed ${this.windowMs/60000}-minute bars for pattern analysis`,
           candleFeed:md.getCandleFeedStatus(),
          marketResolution:'Own-side fresh CLOB quote >= $0.99 settles $1/share, <= $0.01 settles $0/share immediately; otherwise official Gamma result is retried until resolved',analysis:this.analysis||null,
              previousCandles:prior,entryState:this.entryState[this.market?.start]||null},
      positions:this.positions.slice(0,50),events:this.events};
  }
  start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,note:`Demo-only BTC ${this.windowMs/60000}m candle-pattern signal; one ${this.nextEntryShares()}-share entry after ${cfg.ENTRY_DELAY_MS/1000}s, size adjusts by ${cfg.ENTRY_SIZE_STEP_SHARES} after each win/loss, no live orders.`});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={simulateAtBestAsk,feeFor,payout,quoteFromBook,clobWinner,clobQuoteWinner,clobQuoteValue,clobQuoteFloor,takeProfitHit,stopLossHit};
