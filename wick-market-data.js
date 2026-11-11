'use strict';

const GAMMA='https://gamma-api.polymarket.com';
const CLOB='https://clob.polymarket.com';
const BINANCE_DATA='https://data-api.binance.vision';

async function getJson(url){
  const r=await fetch(url,{signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}
function parseArray(x){if(Array.isArray(x))return x;if(typeof x==='string'){try{return JSON.parse(x)}catch(_){}}return []}

async function getBtcMarket(windowStart,windowMs){
  return getAssetMarket('btc',windowStart,windowMs);
}

async function getEthMarket(windowStart,windowMs){
  return getAssetMarket('eth',windowStart,windowMs);
}

async function getAssetMarket(asset,windowStart,windowMs){
  const minutes=windowMs/60000;
  const normalized=String(asset).toLowerCase();
  if(!['btc','eth'].includes(normalized))throw new Error(`Unsupported asset: ${asset}`);
  const slug=`${normalized}-updown-${minutes}m-${Math.floor(windowStart/1000)}`;
  const data=await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  const market=(Array.isArray(data)?data:data.markets||[])[0];
  if(!market)return null;
  const outcomes=parseArray(market.outcomes), ids=parseArray(market.clobTokenIds||market.outcomeTokenIds);
  const tokens={};
  for(let i=0;i<outcomes.length;i++){
    const label=String(typeof outcomes[i]==='string'?outcomes[i]:outcomes[i].name||outcomes[i].label).toLowerCase();
    if(label==='up'||label==='yes')tokens.UP=ids[i];
    if(label==='down'||label==='no')tokens.DOWN=ids[i];
  }
  if(!tokens.UP||!tokens.DOWN)throw new Error(`${normalized.toUpperCase()} ${minutes}-minute market outcomes could not be mapped to UP/DOWN`);
  return {id:String(market.id||market.conditionId),slug,title:market.question||market.title||slug,
    asset:normalized.toUpperCase(),start:windowStart,end:windowStart+windowMs,tokens,feesEnabled:market.feesEnabled,
    feeSchedule:market.feeSchedule,takerFeeRate:market.takerFeeRate,raw:market};
}

async function getBook(tokenId){
  return getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
}
async function getBinanceCandles(asset,windowStart,lookback=5){
  const normalized=String(asset).toUpperCase();
  if(!['BTC','ETH'].includes(normalized))throw new Error(`Unsupported candle asset: ${asset}`);
  const start=Number(windowStart);
  const count=Number(lookback);
  if(!Number.isFinite(start)||!Number.isInteger(count)||count<2||count>20){
    throw new Error('Invalid Binance candle request.');
  }
  const params=new URLSearchParams({
    symbol:`${normalized}USDT`,
    interval:'5m',
    endTime:String(Math.floor(start)-1),
    limit:String(Math.min(count+1,1000)),
  });
  const rows=await getJson(`${BINANCE_DATA}/api/v3/klines?${params}`);
  const candles=(Array.isArray(rows)?rows:[])
    .filter(row=>Array.isArray(row)&&Number(row[6])<start)
    .slice(-count)
    .map(row=>({
      openTime:Number(row[0]),
      open:Number(row[1]),
      high:Number(row[2]),
      low:Number(row[3]),
      close:Number(row[4]),
      volume:Number(row[5]),
      closeTime:Number(row[6]),
    }));
  if(candles.length<count){
    throw new Error(`Binance returned ${candles.length} completed ${normalized} candles; ${count} are required.`);
  }
  return candles;
}

async function getOpeningRangeCandles(asset,windowStart,now=Date.now()){
  const normalized=String(asset).toUpperCase();
  const start=Number(windowStart),timestamp=Number(now);
  if(!['BTC','ETH'].includes(normalized))throw new Error(`Unsupported candle asset: ${asset}`);
  if(!Number.isFinite(start)||!Number.isFinite(timestamp)||timestamp<start+120000){
    throw new Error('Two completed opening-range candles are not available yet.');
  }
  const params=new URLSearchParams({
    symbol:`${normalized}USDT`,
    interval:'1m',
    startTime:String(Math.floor(start-20*60000)),
    endTime:String(Math.floor(Math.min(timestamp-1,start+120000-1))),
    limit:'25',
  });
  const rows=await getJson(`${BINANCE_DATA}/api/v3/klines?${params}`);
  const candles=(Array.isArray(rows)?rows:[])
    .filter(row=>Array.isArray(row)&&Number(row[6])<timestamp)
    .map(row=>({
      openTime:Number(row[0]),
      open:Number(row[1]),
      high:Number(row[2]),
      low:Number(row[3]),
      close:Number(row[4]),
      volume:Number(row[5]),
      closeTime:Number(row[6]),
    }));
  const previous=candles.filter(candle=>candle.openTime<start).slice(-20);
  const opening=candles.filter(candle=>
    candle.openTime>=start&&candle.openTime<start+120000).slice(0,2);
  if(previous.length<20||opening.length<2){
    throw new Error(`Binance returned ${previous.length} prior and ${opening.length} opening candles; 20 and 2 are required.`);
  }
  if(opening[0].openTime!==start||opening[1].openTime!==start+60000){
    throw new Error('Binance opening candles do not align with this Polymarket window.');
  }
  return {previous,opening};
}
async function getMarket(id){return getJson(`${GAMMA}/markets/${encodeURIComponent(id)}`)}

function resolvedWinner(market){
  if(!market||!(market.closed===true||market.closed==='true'))return null;
  const outcomes=parseArray(market.outcomes);
  const prices=parseArray(market.outcomePrices??market.outcome_prices).map(Number);
  if(outcomes.length!==prices.length||prices.some(price=>!Number.isFinite(price)))return null;
  const winners=prices.map((price,index)=>price>=0.999?index:-1).filter(index=>index>=0);
  if(winners.length!==1)return null;
  const label=String(typeof outcomes[winners[0]]==='string'
    ?outcomes[winners[0]]
    :outcomes[winners[0]]?.name||outcomes[winners[0]]?.label||'').trim().toLowerCase();
  if(label==='up'||label==='yes')return 'UP';
  if(label==='down'||label==='no')return 'DOWN';
  return null;
}

module.exports={getAssetMarket,getBtcMarket,getEthMarket,getBook,getBinanceCandles,
  getOpeningRangeCandles,getMarket,resolvedWinner};
