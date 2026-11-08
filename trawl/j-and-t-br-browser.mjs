import { readJtSlider, locateJtSlider, readJtDragState } from './j-and-t-br-slider.mjs';

const PAGE='https://www.jtexpress.com.br/trajectoryQuery';
const API='https://official.jtjms-br.com/official/logisticsTracking/queryPodTracking';
const WIDGET='#tcaptcha_transform_dy';
const CLOCK=/^20\d{2}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?$/;
export const JT_BR_API = API;
export function jAndTBrBrowserNumber(raw, capture = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const number = url.searchParams.get('waybillNo');
  return url.origin + url.pathname === PAGE && !url.username && !url.password && !url.hash
    && [...url.searchParams].length === 1 && /^888\d{12}$/.test(number ?? '')
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === API ? number : null;
}

export function selectJtHistory(d,number) {
  const scalar=x=>typeof x==='number'&&Number.isFinite(x)?x:typeof x==='string'&&/^[\p{L}\p{N} _./-]{1,120}$/u.test(x)?x:null;
  const code=scalar(d?.code),succ=typeof d?.succ==='boolean'?d.succ:null;
  const failureKind = /captcha|ticket|验证码|验证/i.test(String(d?.msg ?? '')) ? 'challenge'
    : /频繁|限流|too many|rate limit/i.test(String(d?.msg ?? '')) ? 'rate_limited' : null;
  if (succ !== true || code !== 1 || d?.fail === true) return { code, succ, data: null, failureKind };
  if(!Array.isArray(d?.data)||d.data.length>30)return {code,succ,data:null};
  if(d.data.some(row=>row?.keyword!==number))return {code,succ,data:null,identityMismatch:true};
  if(d.data.some(row=>!Array.isArray(row.details)||row.details.length>1000))return {code,succ,data:null};
  // Exclude recipient/staff names, remarks, addresses, signatures and POD URLs.
  return {code,succ,data:d.data.map(row=>({keyword:row.keyword,details:row.details.map(scan=>({
    code:scalar(scan?.code),scanTime:typeof scan?.scanTime==='string'&&CLOCK.test(scan.scanTime)?scan.scanTime:null,
    scanTypeName:scalar(scan?.scanTypeName),status:scalar(scan?.status),
  }))}))};
}

export function boundJtRequest(request, number, page) {
  if(request.url()!==API||request.method()!=='POST'||(page&&request.frame()!==page.mainFrame()))return false;
  let d;try{d=request.postDataJSON();}catch{return false;}
  return d&&Array.isArray(d.waybillNos)&&d.waybillNos.length===1&&d.waybillNos[0]===number
    &&Object.keys(d).every(k=>['langType','waybillNos','captcha','ticket'].includes(k))
    &&typeof d.ticket==='string'&&d.ticket.length>0&&typeof d.captcha==='string'&&d.captcha.length>0;
}

export function summarizeJtBody(d,number) {
  const records=Array.isArray(d?.data)?d.data:null;
  const summary={code:typeof d?.code==='number'?d.code:null,succ:d?.succ===true,records:records?.length??null,
    responseWhole:Boolean(records?.length&&records.every(x=>x?.keyword===number)),
    events:records?.reduce((sum,x)=>sum+(Array.isArray(x?.details)?x.details.length:0),0)??0,
    // Empty success has no identity echo or dated history. Keep it distinct.
    outcome:d?.succ===true&&records?.length===0?'empty':records?.length?'records':'unclassified'};
  if(summary.responseWhole){
    const details=records.flatMap(x=>Array.isArray(x.details)?x.details:[]).slice(0,1000);
    const clocks=details.map(x=>x?.scanTime).filter(x=>typeof x==='string'&&CLOCK.test(x));
    summary.datedEvents=clocks.length;summary.clockSamples=clocks.slice(0,3);summary.lastClock=clocks.at(-1)??null;
    summary.recordKeys=[...new Set(records.flatMap(x=>Object.keys(x)))].sort();
    summary.detailKeys=[...new Set(details.flatMap(x=>x&&typeof x==='object'?Object.keys(x):[]))].sort();
  }
  return summary;
}

export async function runJtGuest({handle,number,maxTimeout=90000,signal,installPolicy}) {
  if(!/^[A-Z0-9]{8,40}$/.test(number)||!Number.isFinite(maxTimeout)||maxTimeout<8000)throw Error('Invalid control or budget');
  signal?.throwIfAborted();
  const start=Date.now(),deadline=start+maxTimeout-4000;
  const proof={requests:[],responses:[],verification:[],analysis:[],actions:[],capturedResponses:[],contextClosed:false};
  let context,page,accepting=true,expired=false,timer,abort,route,onResponse,mouseDown=false,requestCount=0;
  const pending=new Set(), trackingPending=new Set();
  let lastTrackingActivity = 0;
  const left=(cap=90000)=>{signal?.throwIfAborted();const n=Math.min(cap,deadline-Date.now());if(n<=0||expired)throw Error('Lookup deadline');return n;};
  const pause=async ms=>{await new Promise(resolve=>setTimeout(resolve,Math.min(ms,left())));left();};
  const inspectSource=`(async()=>{${readJtDragState.toString()}\n${readJtSlider.toString()}\n${locateJtSlider.toString()}\nconst c=await readJtSlider();return c?{signature:c.signature,generation:c.generation,geometry:c.geometry,plan:locateJtSlider(c)}:null;})()`;
  const inspect=()=>page.evaluate(inspectSource);
  let accepted=false,trackingComplete=false,openingContext=false;
  const closeOwned = async target => {
    let closed=false,timer;
    try { await Promise.race([Promise.resolve().then(()=>target.close()).then(()=>{closed=true;}).catch(()=>{}),
      new Promise(resolve=>{timer=setTimeout(resolve,2500);})]); } finally { clearTimeout(timer); }
    if(!closed)handle.requestBrowserReplacement?.('J&T context cleanup failed');
    return closed;
  };
  const observe=task=>{pending.add(task);void task.finally(()=>pending.delete(task));};
  const work=async()=>{
    openingContext=true;const created=await handle.browser.newContext({locale:'pt-BR'});openingContext=false;handle.noteTemporaryContext?.();
    if(expired){proof.lateContextClosed=await closeOwned(created);throw Error('Late context');}context=created;
    page=await context.newPage();left();page.setDefaultTimeout(2500);await installPolicy?.(page);left();
    route=async r=>{
      const req=r.request();if(req.method()==='OPTIONS')return r.continue();
      if(!accepting||expired||Date.now()>=deadline||!boundJtRequest(req,number,page)||requestCount>=2){proof.disallowedAborts=(proof.disallowedAborts??0)+1;return r.abort();}
      requestCount++;trackingPending.add(req);lastTrackingActivity=Date.now();
      proof.requests.push({whole:true,ticketPresent:true,captchaPresent:true,elapsedMs:Date.now()-start});return r.continue();
    };
    await page.route('https://official.jtjms-br.com/official/logisticsTracking/**',route);
    onResponse=response=>{
      if(!accepting)return;
      const request=response.request();let url;try{url=new URL(response.url());}catch{return;}
      if(boundJtRequest(request,number,page)){
        if(proof.responses.length>=2)return;
        const row={status:response.status(),requestWhole:true,elapsedMs:Date.now()-start};proof.responses.push(row);
        const headers = response.headers();
        const capture = { status: response.status(), body: null, error: null, truncated: false,
          headers: Object.fromEntries(['content-type', 'retry-after'].filter(k => headers[k])
            .map(k => [k, headers[k].slice(0,100)])) };
        proof.capturedResponses.push(capture);
        observe((async()=>{
          if(response.status()!==200){trackingComplete=true;return;}
          const declared=Number(headers['content-length']??0);
          if(!Number.isSafeInteger(declared)||declared<0||declared>1000000){capture.truncated=true;trackingComplete=true;return;}
          const raw=await response.body();if(!accepting)return;
          if(raw.length>1000000){row.bodyLimit=true;capture.truncated=true;trackingComplete=true;return;}
          const text=raw.toString('utf8');
          if(/cf-turnstile|_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(text)) {
            capture.body={code:null,succ:null,data:null,failureKind:'challenge'};trackingComplete=true;return;
          }
          let d;try{d=JSON.parse(text);}catch{capture.error='invalid-json';trackingComplete=true;return;}
          Object.assign(row,summarizeJtBody(d,number));
          capture.body=selectJtHistory(d,number);
          trackingComplete=true;
        })().catch(()=>{if(accepting){row.bodyFailed=true;capture.error='body-read';trackingComplete=true;}})
          .finally(()=>{trackingPending.delete(request);lastTrackingActivity=Date.now();}));
      }else if(url.hostname==='ca.turing.captcha.qcloud.com'&&url.pathname==='/cap_union_new_verify'){
        if(proof.verification.length>=2)return;
        const row={status:response.status(),elapsedMs:Date.now()-start};proof.verification.push(row);
        observe((async()=>{
          const raw=await response.body();if(!accepting||raw.length>300000)return;
          const text=raw.toString('utf8').replace(/^[^(]+\(/,'').replace(/\);?\s*$/,'');
          const d=JSON.parse(text);row.errorCode=typeof d.errorCode==='number'||typeof d.errorCode==='string'?String(d.errorCode):null;
          row.ticketPresent=typeof d.ticket==='string'&&d.ticket.length>0;
          if(row.errorCode==='0'&&row.ticketPresent){accepted=true;proof.acceptedVerification=true;}
        })().catch(()=>{if(accepting)row.bodyFailed=true;}));
      }
    };
    page.on('response',onResponse);
    const navigation=await page.goto(PAGE,{waitUntil:'domcontentloaded',timeout:left(20000)});proof.pageStatus=navigation?.status();
    if(page.url()!==PAGE)throw Error('J&T tracking page moved');
    proof.browser=await page.evaluate(()=>navigator.userAgent);
    const field=page.getByPlaceholder('Digite o código de rastreio',{exact:true});
    await field.waitFor({state:'visible',timeout:left(15000)});await field.fill(number,{timeout:left(2500)});await field.press('Enter',{timeout:left(2500)});
    let lastSignature=null;
    while(!trackingComplete){
      left();
      // The page callback can be delayed. Once verified or a tracking request
      // exists, keep observing it instead of looking for a refreshed widget.
      if(accepted||proof.requests.length){await pause(100);continue;}
      if(proof.actions.length>=2)break;
      const found=await page.locator(WIDGET).isVisible().catch(()=>false);if(!found){await pause(150);continue;}
      let a;try{a=await inspect();}catch{proof.inspectionFailed=true;break;}
      if(!a){await pause(150);continue;}
      if(a.signature===lastSignature){await pause(150);continue;}
      await pause(200);const b=await inspect();
      if(!b||a.signature!==b.signature){proof.generationChanges=(proof.generationChanges??0)+1;continue;}
      proof.analysis.push({...b.plan,elapsedMs:Date.now()-start});
      if(!b.plan.ok){proof.abstention='ambiguous_image';break;}
      lastSignature=b.signature;
      const current=await inspect();if(!current||current.signature!==b.signature){proof.abstention='stale_generation';break;}
      const plan=current.plan,base=current.geometry;
      const guard = async () => {
        left();
        const state = await page.evaluate(readJtDragState);
        left();
        if (!state || state.generation !== current.generation) {
          proof.abstention = 'stale_generation';
          throw Error('J&T challenge changed during gesture');
        }
        return state;
      };
      const row={elapsedMs:Date.now()-start,plannedDistance:plan.distance};proof.actions.push(row);
      await guard();await page.mouse.move(plan.start.x,plan.start.y);left();await page.mouse.down();mouseDown=true;
      const calibration=Math.min(12,plan.distance/3);
      await page.mouse.move(plan.start.x+calibration,plan.start.y,{steps:5});await pause(120);
      const moved=await guard();
      const ratio=moved?(moved.pieceX-base.piece.x)/calibration:NaN;
      const knobDelta=moved?moved.knobX-base.knob.x:NaN;
      row.movementRatio=ratio;row.knobDelta=knobDelta;
      if(!Number.isFinite(ratio)||ratio<.7||ratio>1.5||Math.abs(knobDelta-calibration)>2){proof.abstention='unsupported_drag_geometry';break;}
      const distance=plan.distance/ratio;
      if(distance>plan.remaining||distance<calibration){proof.abstention='drag_outside_track';break;}
      for(let step=1;step<=28;step++){
        await guard();await page.mouse.move(plan.start.x+calibration+(distance-calibration)*step/28,plan.start.y);await pause(25);
      }
      await guard();await page.mouse.up();mouseDown=false;
      row.submitted=true;row.actualDistance=distance;
      // Await a verification result or a distinct refreshed generation.
      const until=Math.min(deadline,Date.now()+12000),verifyCount=proof.verification.length;
      while(Date.now()<until&&!accepted&&!trackingComplete){
        if(proof.verification.length>verifyCount){await Promise.allSettled([...pending]);break;}
        await pause(150);
      }
    }
    // Preserve an automatic retry already sent after the first reply, rather
    // than closing on the first accepted response or hiding a later refusal.
    const settleUntil = Math.min(deadline, Date.now() + 1200);
    while (Date.now() < settleUntil && (trackingPending.size || Date.now() - lastTrackingActivity < 350)) await pause(25);
  };
  try{
    await Promise.race([(async()=>{await work();await Promise.allSettled([...pending]);})(),new Promise((_,reject)=>{
      const fail=reason=>{expired=true;reject(reason);};
      timer=setTimeout(()=>fail(Error('Lookup deadline')),Math.max(1,deadline-Date.now()));
      abort=()=>fail(signal.reason??Error('Cancelled'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    })]);
  }catch(e){proof.failure={name:e.name,reason:signal?.aborted?'cancelled':expired?'deadline':'runtime'};}
  finally{
    accepting=false;expired=true;clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);
    if(page&&onResponse)page.off('response',onResponse);
    // Close the owned context while dragging on abort; do not release a stale answer.
    if(context)proof.contextClosed=await closeOwned(context);
    else if(openingContext)handle.requestBrowserReplacement?.('J&T context creation cancelled');
    proof.mouseWasHeldAtCleanup=mouseDown;proof.durationMs=Date.now()-start;
  }
  return proof;
}

/** The production capture boundary retains no images, puzzle answers or page archive. */
export async function runJAndTBrBrowser(options) {
  const number = jAndTBrBrowserNumber(options.url, options.capture);
  if (!number) return undefined;
  const start = Date.now();
  const proof = await runJtGuest({ ...options, number });
  const reason = proof.capturedResponses.length ? 'reply' : proof.abstention
    ?? (proof.failure ? proof.failure.reason : proof.acceptedVerification ? 'capture_missing' : 'verification_unfinished');
  console.warn(JSON.stringify({ level: 'warn', event: 'j-and-t-br.verification',
    outcome: reason, attempts: proof.actions.length, verified: proof.acceptedVerification === true,
    trackingReplies: proof.capturedResponses.length }));
  return { tier: options.tier, status: 'success', durationMs: Date.now() - start,
    effectiveUrl: options.url, html: '', body: new Uint8Array(), statusCode: proof.pageStatus ?? 0,
    cookies: [], reason: `jt-br-${reason}`, capturedResponses: proof.capturedResponses.map(row => ({
      url: API, status: row.status, body: row.body === null ? null : JSON.stringify(row.body),
      headers: row.headers, error: row.error,
      truncated: row.truncated, base64Encoded: false, trackingNumberSubmitted: number,
    })) };
}
