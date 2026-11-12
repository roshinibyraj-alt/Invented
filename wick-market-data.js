'use strict';

const GAMMA='https://gamma-api.polymarket.com';
const CLOB='https://clob.polymarket.com';
const BINANCE_DATA='https://data-api.binance.vision';
const MARKET_WS='wss://ws-subscriptions-clob.polymarket.com/ws/market';

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
function connectMarketStream(tokenIds,options={}){
  const assets=[...new Set((Array.isArray(tokenIds)?tokenIds:[]).map(String).filter(Boolean))];
  if(!assets.length)throw new Error('At least one Polymarket outcome token is required.');
  const WebSocketImpl=options.WebSocketImpl||globalThis.WebSocket;
  if(typeof WebSocketImpl!=='function')throw new Error('This Node runtime does not provide WebSocket.');
  const onMessage=typeof options.onMessage==='function'?options.onMessage:()=>{};
  const onStatus=typeof options.onStatus==='function'?options.onStatus:()=>{};
  const heartbeatMs=Number(options.heartbeatMs)||10000;
  const reconnectMinMs=Number(options.reconnectMinMs)||1000;
  const reconnectMaxMs=Number(options.reconnectMaxMs)||15000;
  const reconnect=options.reconnect!==false;
  let socket=null,pingTimer=null,reconnectTimer=null,stopped=false,reconnectCount=0;
  const report=(status,extra={})=>{try{onStatus({status,reconnectCount,...extra})}catch(_){}};
  const clearPing=()=>{if(pingTimer){clearInterval(pingTimer);pingTimer=null}};
  const parseMessage=data=>{
    if(typeof data==='string')return Promise.resolve(data);
    if(typeof Buffer!=='undefined'&&Buffer.isBuffer(data))return Promise.resolve(data.toString('utf8'));
    if(data&&typeof data.text==='function')return data.text();
    return Promise.resolve(String(data??''));
  };
  const sendHeartbeat=()=>{
    if(stopped||!socket||socket.readyState!==1)return;
    try{socket.send('PING')}
    catch(error){report('ERROR',{error:error?.message||'WebSocket heartbeat failed.'});try{socket.close()}catch(_){}}
  };
  const scheduleReconnect=()=>{
    if(stopped||!reconnect||reconnectTimer)return;
    const delay=Math.min(reconnectMinMs*(2**Math.min(reconnectCount,6)),reconnectMaxMs);
    reconnectCount+=1;
    report('DISCONNECTED',{retryInMs:delay});
    reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect()},delay);
    reconnectTimer.unref?.();
  };
  const connect=()=>{
    if(stopped)return;
    report('CONNECTING');
    try{socket=new WebSocketImpl(MARKET_WS)}
    catch(error){report('ERROR',{error:error?.message||'WebSocket connection could not start.'});scheduleReconnect();return}
    const current=socket;
    current.addEventListener('open',()=>{
      if(stopped||current!==socket)return;
      try{current.send(JSON.stringify({assets_ids:assets,type:'market',custom_feature_enabled:true}))}
      catch(error){report('ERROR',{error:error?.message||'WebSocket subscription failed.'});try{current.close()}catch(_){};return}
      reconnectCount=0;
      report('CONNECTED');
      clearPing();
      pingTimer=setInterval(sendHeartbeat,heartbeatMs);
      pingTimer.unref?.();
    });
    current.addEventListener('message',event=>{
      if(stopped||current!==socket)return;
      void parseMessage(event?.data).then(text=>{
        if(text==='PONG'||text==='PING'||!text)return;
        let parsed;
        try{parsed=JSON.parse(text)}
        catch(error){report('ERROR',{error:'Received an unreadable market WebSocket message.'});return}
        for(const message of Array.isArray(parsed)?parsed:[parsed]){
          if(message&&typeof message==='object'){
            try{onMessage(message)}catch(onError){report('ERROR',{error:onError?.message||'Market update handler failed.'})}
          }
        }
      }).catch(error=>report('ERROR',{error:error?.message||'Market WebSocket message failed.'}));
    });
    current.addEventListener('error',()=>{
      if(!stopped&&current===socket)report('ERROR',{error:'Polymarket market WebSocket reported an error.'});
    });
    current.addEventListener('close',event=>{
      if(current!==socket)return;
      clearPing();
      if(stopped)return;
      scheduleReconnect();
      if(event?.code)report('DISCONNECTED',{closeCode:event.code});
    });
  };
  connect();
  return {
    close(){
      if(stopped)return;
      stopped=true;
      clearPing();
      if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}
      const current=socket;
      socket=null;
      try{current?.close()}catch(_){}
      report('DISCONNECTED');
    },
  };
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

module.exports={getAssetMarket,getBtcMarket,getEthMarket,getBook,connectMarketStream,getBinanceCandles,getMarket,resolvedWinner};
