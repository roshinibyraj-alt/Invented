'use strict';

const cfg=require('./config');
const Bot=require('./wick-bot');

class MultiBot {
  constructor(){
    this.bots={
      '5m':new Bot({timeframe:'5m',windowMs:5*60*1000,capital:cfg.DEMO_CAPITAL_5M}),
      '15m':new Bot({timeframe:'15m',windowMs:15*60*1000,capital:cfg.DEMO_CAPITAL_15M}),
    };
  }
  start(){for(const bot of Object.values(this.bots))bot.start()}
  stop(){for(const bot of Object.values(this.bots))bot.stop()}
  snapshot(){
    const timeframes=Object.fromEntries(Object.entries(this.bots).map(([k,b])=>[k,b.snapshot()]));
    const states=Object.values(timeframes),positions=states.flatMap(s=>s.positions)
      .sort((a,b)=>b.openedAt-a.openedAt),events=states.flatMap(s=>s.events).sort((a,b)=>b.ts-a.ts).slice(0,100);
    const openPositions=states.reduce((n,s)=>n+s.account.openPositions,0);
    const status=states.some(s=>s.status==='blocked_or_error')?'blocked_or_error':
      states.some(s=>['scanning','position_open'].includes(s.status))?
        (openPositions?'position_open':'scanning'):'waiting_for_market';
    const primary=timeframes['15m'];
    return {...primary,now:Date.now(),status,timeframes,positions,events,
      error:states.find(s=>s.error)?.error||null,
      strategy:{execution:'PAPER ONLY',independentTimeframes:true},
      account:{capital:states.reduce((n,s)=>n+s.account.capital,0),
        cash:states.reduce((n,s)=>n+s.account.cash,0),
        realizedPnl:states.reduce((n,s)=>n+s.account.realizedPnl,0),
        unrealizedPnl:states.reduce((n,s)=>n+s.account.unrealizedPnl,0),
        equity:states.reduce((n,s)=>n+s.account.equity,0),
        markedValue:states.reduce((n,s)=>n+s.account.markedValue,0),
        unpricedOpenPositions:states.reduce((n,s)=>n+s.account.unpricedOpenPositions,0),openPositions}};
  }
}

module.exports=MultiBot;
