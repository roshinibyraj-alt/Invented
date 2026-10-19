'use strict';

const GAMMA='https://gamma-api.polymarket.com';
const CLOB='https://clob.polymarket.com';

async function getJson(url){
  const r=await fetch(url,{signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}
function parseArray(x){if(Array.isArray(x))return x;if(typeof x==='string'){try{return JSON.parse(x)}catch(_){}}return []}

async function getBtcMarket(windowStart,windowMs){
  const minutes=windowMs/60000;
  const slug=`btc-updown-${minutes}m-${Math.floor(windowStart/1000)}`;
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
  if(!tokens.UP||!tokens.DOWN)throw new Error(`BTC ${minutes}-minute market outcomes could not be mapped to UP/DOWN`);
  return {id:String(market.id||market.conditionId),slug,title:market.question||market.title||slug,
    start:windowStart,end:windowStart+windowMs,tokens,raw:market};
}

async function getBook(tokenId){
  return getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
}
async function getMarket(id){return getJson(`${GAMMA}/markets/${encodeURIComponent(id)}`)}

module.exports={getBtcMarket,getBook,getMarket};
