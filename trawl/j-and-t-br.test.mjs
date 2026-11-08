import test from 'node:test';
import assert from 'node:assert/strict';
import {locateJtSlider,readJtDragState} from './j-and-t-br-slider.mjs';
import {boundJtRequest,summarizeJtBody,runJtGuest,selectJtHistory,jAndTBrBrowserNumber,runJAndTBrBrowser} from './j-and-t-br-browser.mjs';

function fixture({target=200,duplicate=null,scale=2}={}) {
  const width=360,height=180,size=60,y=55;
  const data=new Uint8ClampedArray(width*height*4),piece=new Uint8ClampedArray(size*size*4);
  let seed=17;
  for(let i=0;i<width*height;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const v=100+seed%140;data.set([v,Math.min(255,v+12),Math.max(0,v-10),255],i*4);}
  for(let py=0;py<size;py++)for(let px=0;px<size;px++){
    const shape=(px>=8&&px<52&&py>=12&&py<52)||((px-30)**2+(py-12)**2<49&&py<12);
    if(!shape||(px-30)**2+(py-52)**2<25)continue;
    const at=((y+py)*width+target+px)*4,pt=(py*size+px)*4;
    piece.set(data.slice(at,at+4),pt);
    for(let c=0;c<3;c++)data[at+c]=Math.round(piece[pt+c]*.2);
  }
  if(duplicate!==null)for(let py=0;py<size;py++)for(let px=0;px<size;px++){
    data.set(data.slice(((y+py)*width+target+px)*4,((y+py)*width+target+px)*4+4),((y+py)*width+duplicate+px)*4);
  }
  return {background:{width,height,data},piece:{width:size,height:size,data:piece},
    geometry:{scale,startX:12,expectedY:y,track:{x:0,width:400},knob:{x:2,width:40,y:220,height:30}}};
}

test('matches image-derived displacement at different target positions and scales',()=>{
  for(const [target,scale]of [[180,1],[240,2],[150,1.5]]){
    const result=locateJtSlider(fixture({target,scale}));
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.texture.x,target);
    assert.equal(result.distance,(target-12)/scale);
  }
});
test('duplicate matching cutouts abstain instead of choosing the first',()=>{
  assert.equal(locateJtSlider(fixture({target:240,duplicate:130})).ok,false);
});
test('missing alpha shape cannot produce a drag',()=>{
  const c=fixture();c.piece.data.fill(255);assert.equal(locateJtSlider(c).ok,false);
});
test('whole identifier, exact endpoint, allowed fields and guest tokens are mandatory',()=>{
  const n='888000000000198',api='https://official.jtjms-br.com/official/logisticsTracking/queryPodTracking';
  const request=(data,url=api,method='POST')=>({url:()=>url,method:()=>method,postDataJSON:()=>data});
  const d={waybillNos:[n],langType:'PT',captcha:'synthetic',ticket:'synthetic'};
  assert.equal(boundJtRequest(request(d),n),true);
  for(const value of [{...d,waybillNos:[n+'0']},{...d,waybillNos:[n,n]},{...d,cpf:'synthetic'},{...d,ticket:''}])assert.equal(Boolean(boundJtRequest(request(value),n)),false);
  assert.equal(boundJtRequest(request(d,api+'?x=1'),n),false);
  assert.equal(boundJtRequest(request(d,api.replace('queryPodTracking','getWaybillByCpf')),n),false);
});
test('empty native success is not response identity or positive history',()=>{
  assert.deepEqual(summarizeJtBody({code:1,succ:true,data:[]},'synthetic'),{code:1,succ:true,records:0,responseWhole:false,events:0,outcome:'empty'});
  const r=summarizeJtBody({code:1,succ:true,data:[{keyword:'other',details:[{}]}]},'synthetic');
  assert.equal(r.responseWhole,false);assert.equal(r.events,1);
});

test('already cancelled work never opens a browser context',async()=>{
  const controller=new AbortController();controller.abort();let opened=0;
  await assert.rejects(runJtGuest({number:'888000000000198',signal:controller.signal,
    handle:{browser:{newContext:async()=>{opened++;}}}}),{name:'AbortError'});
  assert.equal(opened,0);
});
test('cancellation during navigation closes the owned context and removes observation',async()=>{
  const controller=new AbortController();let closed=0,removed=0,rejectNavigation;
  const page={setDefaultTimeout(){},route:async()=>{},on(){},off(){removed++;},
    goto:()=>new Promise((_,reject)=>{rejectNavigation=reject;setTimeout(()=>controller.abort(),5);})};
  const context={newPage:async()=>page,close:async()=>{closed++;rejectNavigation?.(Error('closed'));}};
  const proof=await runJtGuest({number:'888000000000198',signal:controller.signal,maxTimeout:8000,
    handle:{browser:{newContext:async()=>context}}});
  assert.equal(proof.failure.reason,'cancelled');assert.equal(proof.contextClosed,true);
  assert.equal(closed,1);assert.equal(removed,1);assert.equal(proof.actions.length,0);
});
test('dated positive metadata requires an exact response identifier',()=>{
  const good={code:1,succ:true,data:[{keyword:'synthetic',details:[{scanTime:'2026-08-20 10:30:00'}]}]};
  assert.equal(summarizeJtBody(good,'synthetic').datedEvents,1);
  assert.equal(summarizeJtBody(good,'different').datedEvents,undefined);
});

test('capture excludes recipient, signature, document and arbitrary remark fields',()=>{
  const body={code:1,succ:true,data:[{keyword:'synthetic',recipient:'private',details:[{
    code:'DELIVERED',scanTime:'2026-08-20 10:30:00',scanTypeName:'Entrega',status:1,
    deliveryName:'private',electronicSignaturePicUrl:'https://private.invalid',remark1:'private address',staffCode:'private',
  }]}]};
  assert.deepEqual(selectJtHistory(body,'synthetic'),{code:1,succ:true,data:[{keyword:'synthetic',details:[{
    code:'DELIVERED',scanTime:'2026-08-20 10:30:00',scanTypeName:'Entrega',status:1,
  }]}]});
  assert.equal(selectJtHistory(body,'different').identityMismatch,true);
  assert.equal(selectJtHistory(body,'different').data,null);
});

const TEST_NUMBER = '888000000000198';
const API = 'https://official.jtjms-br.com/official/logisticsTracking/queryPodTracking';
const PAGE = 'https://www.jtexpress.com.br/trajectoryQuery';
test('production helper is restricted to one carrier form, shape and capture', () => {
  const capture={captureResponses:[API]},url=PAGE+'?waybillNo='+TEST_NUMBER;
  assert.equal(jAndTBrBrowserNumber(url,capture),TEST_NUMBER);
  for(const value of [url+'&waybillNo='+TEST_NUMBER,url+'&type=0',url+'#extra',url.replace('www.','user@www.'),url.replace('888','999'),url.replace('trajectoryQuery','mobile/expressTracking')])
    assert.equal(jAndTBrBrowserNumber(value,capture),null);
  assert.equal(jAndTBrBrowserNumber(url,{captureResponses:[API,API]}),null);
});
test('tracking POST must originate in the owned main frame', () => {
  const main={},page={mainFrame:()=>main},request={url:()=>API,method:()=> 'POST',
    postDataJSON:()=>({waybillNos:[TEST_NUMBER],ticket:'synthetic',captcha:'synthetic'}),frame:()=>({})};
  assert.equal(boundJtRequest(request,TEST_NUMBER,page),false);
  request.frame=()=>main;assert.equal(boundJtRequest(request,TEST_NUMBER,page),true);
});
test('generation ignores drag x but rejects refreshed assets, crop and ancestor fade', () => {
  const oldDocument=globalThis.document,oldStyle=globalThis.getComputedStyle;
  const nodes=Array.from({length:4},(_,i)=>({x:i*20,y:20,width:40,height:30,parentElement:null,
    style:{display:'block',visibility:'visible',opacity:'1',backgroundImage:'url(synthetic)',backgroundSize:'100px 100px',backgroundPosition:'0px 0px'},
    getBoundingClientRect(){return this;}}));
  const selectors=['.tencent-captcha-dy__verify-bg-img','.tencent-captcha-dy__fg-item','.tencent-captcha-dy__slider-block','.tencent-captcha-dy__verify-slider-area'];
  const root={innerText:'synthetic question',querySelectorAll:s=>[nodes[selectors.indexOf(s)]]};
  globalThis.document={querySelector:()=>root};globalThis.getComputedStyle=e=>e.style;
  try{
    const initial=readJtDragState().generation;
    nodes[1].x+=10;nodes[2].x+=10;assert.equal(readJtDragState().generation,initial);
    nodes[1].style.backgroundPosition='1px 0px';assert.notEqual(readJtDragState().generation,initial);
    nodes[1].style.opacity='.5';assert.equal(readJtDragState(),null);
  }finally{globalThis.document=oldDocument;globalThis.getComputedStyle=oldStyle;}
});
function browserHarness({staleAt=Infinity,cancelAt=Infinity,replies,lateContext=false}={}){
  const controller=new AbortController(),frame={},listeners=new Map();
  let moves=0,ups=0,closed=0,guardCalls=0,replacement=0,routeHandler;
  const plan={ok:true,distance:80,start:{x:10,y:100},remaining:200};
  const inspection={signature:'fixture',generation:'g1',plan,geometry:{piece:{x:0},knob:{x:0}}};
  const request={url:()=>API,method:()=> 'POST',frame:()=>frame,postDataJSON:()=>({waybillNos:[TEST_NUMBER],ticket:'synthetic',captcha:'synthetic'})};
  const page={setDefaultTimeout(){},route:async(_,r)=>{routeHandler=r;},on:(k,v)=>listeners.set(k,v),off:k=>listeners.delete(k),
    goto:async()=>({status:()=>200}),url:()=>PAGE,mainFrame:()=>frame,
    getByPlaceholder:()=>({waitFor:async()=>{},fill:async()=>{},press:async()=>{}}),locator:()=>({isVisible:async()=>true}),
    evaluate:async fn=>{
      if(typeof fn==='string')return inspection;
      if(fn.name==='readJtDragState'){guardCalls++;if(guardCalls===cancelAt)controller.abort();return{generation:guardCalls>=staleAt?'g2':'g1',pieceX:moves?12:0,knobX:moves?12:0};}
      return 'synthetic browser';
    },mouse:{move:async()=>{moves++;},down:async()=>{},up:async()=>{
      ups++;
      for(const reply of replies??[{status:200,body:{code:1,succ:true,data:[]}}]){
        await routeHandler({request:()=>request,continue:async()=>{},abort:async()=>assert.fail('valid request aborted')});
        listeners.get('response')({url:()=>API,request:()=>request,status:()=>reply.status,
          headers:()=>reply.headers??{},body:async()=>Buffer.from(reply.raw??JSON.stringify(reply.body))});
      }
    }}};
  const context={newPage:async()=>page,close:async()=>{closed++;}};
  const handle={browser:{newContext:async()=>{if(lateContext)await new Promise(r=>setTimeout(r,30));return context;}},
    requestBrowserReplacement:()=>{replacement++;}};
  return{handle,controller,state:()=>({moves,ups,closed,guardCalls,replacement,listeners:listeners.size})};
}
test('a refresh during calibration, mid-drag or immediately before release never submits stale input', async()=>{
  for(const staleAt of [2,12,31]){
    const h=browserHarness({staleAt});const proof=await runJtGuest({handle:h.handle,number:TEST_NUMBER,maxTimeout:8000});
    assert.equal(proof.abstention,'stale_generation');assert.equal(h.state().ups,0);
    assert.equal(h.state().closed,1);assert.equal(proof.mouseWasHeldAtCleanup,true);
  }
});
test('cancellation while holding the knob closes without release',async()=>{
  const h=browserHarness({cancelAt:3});const proof=await runJtGuest({handle:h.handle,number:TEST_NUMBER,maxTimeout:8000,signal:h.controller.signal});
  assert.equal(proof.failure.reason,'cancelled');assert.equal(h.state().ups,0);assert.equal(h.state().closed,1);
  assert.equal(h.state().listeners,0);
});
test('late context creation after cancellation requests replacement and closes the late context',async()=>{
  const h=browserHarness({lateContext:true});setTimeout(()=>h.controller.abort(),5);
  const proof=await runJtGuest({handle:h.handle,number:TEST_NUMBER,maxTimeout:8000,signal:h.controller.signal});
  assert.equal(proof.failure.reason,'cancelled');assert.equal(h.state().replacement,1);
  await new Promise(r=>setTimeout(r,45));assert.equal(h.state().closed,1);
});
test('production capture retains bounded reply order and rate headers without solver or recipient data',async()=>{
  const h=browserHarness({replies:[{status:200,body:{code:1,succ:true,data:[]}},{status:429,headers:{'retry-after':'120','set-cookie':'private'},raw:'private'}]});
  const warn=console.warn;let diagnostic;
  console.warn=s=>{diagnostic=s;};
  try{
    const result=await runJAndTBrBrowser({handle:h.handle,url:PAGE+'?waybillNo='+TEST_NUMBER,capture:{captureResponses:[API]},maxTimeout:8000,tier:3});
    assert.deepEqual(result.capturedResponses.map(x=>x.status),[200,429]);
    assert.deepEqual(result.capturedResponses[1].headers,{'retry-after':'120'});
    assert.equal(result.capturedResponses.every(x=>x.trackingNumberSubmitted===TEST_NUMBER),true);
    assert.equal(result.capturedResponses[1].body,null);
    assert.doesNotMatch(JSON.stringify(result),/private|plannedDistance|movementRatio|signature/);
    assert.doesNotMatch(diagnostic,/888|synthetic|ticket|captcha/i);
    assert.equal(h.state().closed,1);
  }finally{console.warn=warn;}
});
test('an invalid JSON tracking body stays a schema marker instead of empty history',async()=>{
  const h=browserHarness({replies:[{status:200,raw:'not JSON'}]});
  const proof=await runJtGuest({handle:h.handle,number:TEST_NUMBER,maxTimeout:8000});
  assert.equal(proof.capturedResponses[0].error,'invalid-json');
});
