'use strict';

const cfg=require('./config');
const Bot=require('./wick-bot');

class MultiBot {
  constructor(){
    this.bots={
      '5m':new Bot({timeframe:'5m',windowMs:cfg.WINDOW_MS_5M,capital:cfg.DEMO_CAPITAL_5M})
    };
  }
  start(){for(const bot of Object.values(this.bots))bot.start()}
  stop(){for(const bot of Object.values(this.bots))bot.stop()}
  snapshot(){
    const timeframes=Object.fromEntries(Object.entries(this.bots).map(([k,b])=>[k,b.snapshot()]));
    const states=Object.values(timeframes),positions=states.flatMap(s=>s.positions)
      .sort((a,b)=>b.openedAt-a.openedAt),events=states.flatMap(s=>s.events).sort((a,b)=>b.ts-a.ts).slice(0,100);
    const openPositions=states.reduce((n,s)=>n+s.account.openPositions,0);
    const totalTrades=states.reduce((n,s)=>n+s.account.totalTrades,0),settledTrades=states.reduce((n,s)=>n+s.account.settledTrades,0);
    const wins=states.reduce((n,s)=>n+s.account.wins,0),losses=states.reduce((n,s)=>n+s.account.losses,0);
    const status=states.some(s=>s.status==='blocked_or_error')?'blocked_or_error':
      states.some(s=>['scanning','position_open'].includes(s.status))?
        (openPositions?'position_open':'scanning'):'waiting_for_market';
    const primary=timeframes['5m'],capital=states.reduce((n,s)=>n+s.account.capital,0);
    const series=states.map(s=>s.account.equityCurve||[]);
    const current=series.map(x=>Number(x[0]?.equity||0));
    const startTs=Math.min(...series.map(x=>Number(x[0]?.ts||Date.now())));
    const equityCurve=[{ts:startTs,equity:capital}];
    const settled=series.flatMap((curve,index)=>curve.slice(1).map(point=>({ts:point.ts,index,equity:point.equity})))
      .sort((a,b)=>a.ts-b.ts);
    for(const point of settled){current[point.index]=Number(point.equity);equityCurve.push({ts:point.ts,equity:current.reduce((n,x)=>n+x,0)});}
    let peak=equityCurve[0]?.equity||capital,maxDrawdown=0;
    for(const point of equityCurve){peak=Math.max(peak,point.equity);maxDrawdown=Math.max(maxDrawdown,peak-point.equity);}
    return {...primary,now:Date.now(),status,timeframes,positions,events,
      error:states.find(s=>s.error)?.error||null,
      strategy:{execution:'PAPER ONLY',timeframes:['5m']},
      account:{capital,
        cash:states.reduce((n,s)=>n+s.account.cash,0),
        realizedPnl:states.reduce((n,s)=>n+s.account.realizedPnl,0),
        unrealizedPnl:states.reduce((n,s)=>n+s.account.unrealizedPnl,0),
        equity:states.reduce((n,s)=>n+s.account.equity,0),
         takerFees:states.reduce((n,s)=>n+s.account.takerFees,0),
         estimatedMakerRebate:states.reduce((n,s)=>n+s.account.estimatedMakerRebate,0),
        markedValue:states.reduce((n,s)=>n+s.account.markedValue,0),
         unpricedOpenPositions:states.reduce((n,s)=>n+s.account.unpricedOpenPositions,0),totalTrades,settledTrades,wins,losses,winRate:settledTrades?wins/settledTrades*100:0,openPositions,
         maxConsecutiveLosses:Math.max(...states.map(s=>s.account.maxConsecutiveLosses)),
         maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
         equityCurve}};
  }
}

module.exports=MultiBot;
