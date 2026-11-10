'use strict';

const WickySignalBot=require('./wicky-signal-bot');

class MultiBot {
  constructor(){
    this.bots={
      'btc-eth-next-candle-predictor':new WickySignalBot(),
    };
  }
  start(){for(const bot of Object.values(this.bots))bot.start()}
  stop(){for(const bot of Object.values(this.bots))bot.stop()}
  snapshot(){
    const strategies=Object.fromEntries(Object.entries(this.bots).map(([k,b])=>[k,b.snapshot()]));
    const primary=strategies['btc-eth-next-candle-predictor'];
    const timeframes={'5m':primary};
    const states=Object.values(strategies),positions=states.flatMap(s=>s.positions)
      .sort((a,b)=>b.openedAt-a.openedAt),events=states.flatMap(s=>s.events).sort((a,b)=>b.ts-a.ts).slice(0,100);
    const openPositions=states.reduce((n,s)=>n+s.account.openPositions,0);
    const totalTrades=states.reduce((n,s)=>n+s.account.totalTrades,0),settledTrades=states.reduce((n,s)=>n+s.account.settledTrades,0);
    const wins=states.reduce((n,s)=>n+s.account.wins,0),losses=states.reduce((n,s)=>n+s.account.losses,0);
     const profitableExits=states.reduce((n,s)=>n+s.account.profitableExits,0);
     const losingExits=states.reduce((n,s)=>n+s.account.losingExits,0);
     const breakEvenExits=states.reduce((n,s)=>n+s.account.breakEvenExits,0);
    const status=states.some(s=>s.status==='blocked_or_error')?'blocked_or_error':
      states.some(s=>s.status==='strategy_stopped')?'strategy_stopped':
      states.some(s=>['scanning','position_open'].includes(s.status))?
        (openPositions?'position_open':'scanning'):
        states.every(s=>s.status==='window_complete')?'window_complete':'waiting_for_market';
    const capital=states.reduce((n,s)=>n+s.account.capital,0);
    const series=states.map(s=>s.account.equityCurve||[]);
    const current=series.map(x=>Number(x[0]?.equity||0));
    const startTs=Math.min(...series.map(x=>Number(x[0]?.ts||Date.now())));
    const equityCurve=[{ts:startTs,equity:capital}];
    const settled=series.flatMap((curve,index)=>curve.slice(1).map(point=>({ts:point.ts,index,equity:point.equity})))
      .sort((a,b)=>a.ts-b.ts);
    for(const point of settled){current[point.index]=Number(point.equity);equityCurve.push({ts:point.ts,equity:current.reduce((n,x)=>n+x,0)});}
    let peak=equityCurve[0]?.equity||capital,maxDrawdown=0;
    for(const point of equityCurve){peak=Math.max(peak,point.equity);maxDrawdown=Math.max(maxDrawdown,peak-point.equity);}
    return {...primary,now:Date.now(),status,timeframes,strategies,positions,events,
      error:states.find(s=>s.error)?.error||null,
        strategy:{...primary.strategy,execution:'PAPER ONLY',timeframes:['5m'],strategyIds:Object.keys(strategies)},
      account:{capital,
        cash:states.reduce((n,s)=>n+s.account.cash,0),
        realizedPnl:states.reduce((n,s)=>n+s.account.realizedPnl,0),
        unrealizedPnl:states.reduce((n,s)=>n+s.account.unrealizedPnl,0),
        equity:states.reduce((n,s)=>n+s.account.equity,0),
         takerFees:states.reduce((n,s)=>n+s.account.takerFees,0),
         estimatedMakerRebate:states.reduce((n,s)=>n+s.account.estimatedMakerRebate,0),
        markedValue:states.reduce((n,s)=>n+s.account.markedValue,0),
         unpricedOpenPositions:states.reduce((n,s)=>n+s.account.unpricedOpenPositions,0),totalTrades,settledTrades,wins,losses,
         profitableExits,losingExits,breakEvenExits,winRate:settledTrades?wins/settledTrades*100:0,openPositions,
          maxConsecutiveWins:Math.max(...states.map(s=>s.account.maxConsecutiveWins)),
          maxConsecutiveLosses:Math.max(...states.map(s=>s.account.maxConsecutiveLosses)),
         maxDrawdown,maxDrawdownPercent:peak?maxDrawdown/peak*100:0,
         equityCurve}};
  }
  diagnostics(){
    const state=this.snapshot();
    const perStrategy=Object.fromEntries(Object.entries(this.bots).map(([strategyId,bot])=>[
      strategyId,{sessionStartedAt:bot.startedAt,tradeCount:bot.positions.length,
        orderAttempts:bot.totalOrderAttempts,retainedOrders:bot.orders.length},
    ]));
    const trades=Object.values(this.bots).flatMap(bot=>bot.positions)
      .slice().sort((a,b)=>(a.filledAt||a.openedAt||0)-(b.filledAt||b.openedAt||0));
    const orders=Object.values(this.bots).flatMap(bot=>bot.orders)
      .slice().sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    const summarize=items=>{
      const settled=items.filter(item=>item.status==='SETTLED_EXIT');
      const wins=settled.filter(item=>(Number(item.realizedPnl)||0)>0).length;
      const losses=settled.filter(item=>(Number(item.realizedPnl)||0)<0).length;
      return {positions:items.length,settled:settled.length,
        open:items.filter(item=>['OPEN','PENDING_RESOLUTION'].includes(item.status)).length,
        wins,losses,winRate:settled.length?wins/settled.length*100:0,
        realizedPnl:settled.reduce((sum,item)=>sum+(Number(item.realizedPnl)||0),0),
        totalCost:items.reduce((sum,item)=>sum+(Number(item.totalCost)||0),0),
        proceeds:settled.reduce((sum,item)=>sum+(Number(item.proceeds)||0),0)};
    };
    const group=(items,keyOf)=>Object.fromEntries([...new Set(items.map(keyOf).filter(Boolean))]
      .sort().map(key=>[key,summarize(items.filter(item=>keyOf(item)===key))]));
    return {generatedAt:Date.now(),mode:'DEMO ONLY',execution:'PAPER ONLY',
      account:state.account,equityCurve:state.account.equityCurve,
      strategies:perStrategy,
      tradeCount:trades.length,orderAttempts:Object.values(this.bots)
        .reduce((sum,bot)=>sum+bot.totalOrderAttempts,0),
      retainedOrderCount:orders.length,orderHistoryTruncated:orders.length<
        Object.values(this.bots).reduce((sum,bot)=>sum+bot.totalOrderAttempts,0),
      summary:{bySide:group(trades,item=>item.side),
        byStrategy:group(trades,item=>item.strategyId||'UNKNOWN'),
        byEntryMode:group(trades,item=>item.entryMode||'UNKNOWN'),
        byExitReason:group(trades,item=>item.exitReason||item.settlementBasis||'OPEN')},
      trades,orders};
  }
}

module.exports=MultiBot;
