'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(require('node:path').join(__dirname,'../public/freqai-dashboard.html'),'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
async function render(state) {
  const elements = new Map();
  const element = () => ({textContent:'',innerHTML:'',className:'',style:{},dataset:{},
    addEventListener(){},setAttribute(){},classList:{add(){},remove(){}},querySelectorAll(){return [];}});
  const context = {document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    addEventListener(){},visibilityState:'visible'},fetch:async()=>({ok:true,json:async()=>state}),
    setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},AbortController,Date,Intl,console,
    navigator:{onLine:true},window:{addEventListener(){}}};
  vm.runInNewContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  return elements;
}
test('dashboard shows model probabilities, current position and resolution history',async()=>{
  const p={id:'p1',asset:'BTC',side:'UP',windowStart:1800000000000,windowEnd:1800000300000,shares:10,entryPrice:.4,originalShares:10,totalCost:4,fees:.01,unrealizedPnl:1,realizedPnl:20,exitPrice:1};
  const e=await render({now:1800000090000,status:'RUNNING',account:{cash:3000,equity:3020,initialCapital:3000,availableCash:3000,unrealizedPnl:1,winRate:75,totalFees:.01,settledPositions:4,openPositions:1},
    freqai:{status:'READY',prediction:{side:'UP',pUp:.7,pDown:.3,model:'LightGBMClassifier',candleStart:1800000000000}},
    currentDecision:{side:'UP',pUp:.7,pDown:.3,source:'FREQAI',at:1800000090000},
    markets:[{asset:'BTC',timeframe:'5m',start:p.windowStart,end:p.windowEnd,marketStatus:'OPEN',secondsRemaining:210,sideStates:{UP:{bestBid:.44,bestAsk:.45,mid:.445,fresh:true},DOWN:{bestBid:.54,bestAsk:.55,mid:.545,fresh:true}},triggeredSide:'UP'}],
    positions:[{...p,status:'OPEN'},{...p,id:'resolved',status:'RESOLVED_WIN',realizedPnl:2},{...p,id:'pending',status:'PENDING_RESOLUTION'}],
    events:[{type:'FIRST',time:1800000090000,message:'<script>bad</script>'},{type:'SECOND',time:1800000080000,message:'next'}]});
  assert.match(e.get('position').innerHTML,/10 shares/);
  assert.equal(e.get('pendingCount').textContent,1);
  assert.equal(e.get('closedCount').textContent,1);
  assert.equal(e.get('pUp').textContent,'70.0%');
  assert.equal(e.get('pDown').textContent,'30.0%');
  assert.match(e.get('closed').innerHTML,/out \$1\.000/);
  assert.doesNotMatch(e.get('events').innerHTML,/<script>bad/);
  assert.match(e.get('events').innerHTML,/&lt;script&gt;/);
  assert.ok(e.get('events').innerHTML.indexOf('FIRST')<e.get('events').innerHTML.indexOf('SECOND'));
});

test('dashboard renders the saved equity chart and readable flip-audit checks',async()=>{
  const e=await render({
    now:1800000090000,
    account:{cash:3000,equity:3020,initialCapital:3000,equityCurve:[
      {at:1800000000000,equity:3000},{at:1800000060000,equity:3020},
    ]},
    freqai:{auditTrail:[{
      predictionAt:1800000085000,windowStart:1800000000000,candleStart:1800000060000,
      predictedSide:'DOWN',pUp:.38,pDown:.62,heldSide:'UP',oppositeProbability:.62,
      flipQualified:true,status:'WAITING_FOR_HELD_BIDS',reason:'Waiting for fresh visible bids.',
      selectedBook:{bestBid:.4,bestAsk:.41,visibleBidShares:100,visibleAskShares:200,fresh:true},
      heldBook:{bestBid:null,bestAsk:.6,visibleBidShares:0,visibleAskShares:20,fresh:false,ageMs:3000},
      checks:[{at:1800000085000,status:'FLIP_SIGNAL_QUALIFIED',reason:'Opposite score exceeds 60%.'}],
    }],auditPersistence:{enabled:true}},
    markets:[],positions:[],events:[],
  });
  assert.match(e.get('equityChart').innerHTML,/chart-line/);
  assert.match(e.get('equityRange').textContent,/2 points/);
  assert.match(e.get('auditTrail').innerHTML,/DOWN/);
  assert.match(e.get('auditTrail').innerHTML,/QUALIFIED/);
  assert.match(e.get('auditTrail').innerHTML,/Waiting for held-side bids/);
  assert.match(e.get('auditTrail').innerHTML,/Waiting for fresh visible bids/);
});
