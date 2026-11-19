import test from 'node:test';
import assert from 'node:assert/strict';
import { costaRicaBrowserNumber, costaRicaHistory, costaRicaPostMatches, runCostaRicaBrowser, COSTA_RICA_PAGE as PAGE, COSTA_RICA_POST as POST } from './correos-costa-rica-browser.mjs';
const number = 'RR123456785CR', url = PAGE + '?tracking=' + number, capture = { captureResponses: [POST] };
const html = `<html><body><form><input value="PRIVATE"><textarea>PRIVATE</textarea></form><ul><li class="d-flex justify-content-between"><span>Número de envío</span><span>${number}</span></li><li>Recibido por: PRIVATE</li></ul><table><tr><td class="col-3">PRIVATE</td><td class="col-9"><h5><b>04/03/26 12:05 PM</b></h5><h5><b>ESCAZU</b></h5><b class="upperCase">Tu envío fue entregado con éxito.</b></td></tr></table></body></html>`;
const request = (page, value = number, extra = {}) => ({ url: () => POST, method: () => 'POST', frame: () => page.mainFrame(), redirectedFrom: () => null,
  postData: () => new URLSearchParams({ tracking: value, _token: 'PRIVATE', 'g-recaptcha-response': 'PRIVATE' }).toString(), ...extra });
function fixture({ status = 200, data = html, token = true, delay = 0, cooldown = 0, abort = null, location = PAGE } = {}) {
  const state = { closed: 0, native: 0, checkbox: 0, filled: null, posts: 0, aborted: 0, observerBeforeNavigation: false }; const frame = {};
  let responseHandler, routeHandler;
  const page = { route: async (_, fn) => { routeHandler = fn; }, mainFrame: () => frame, on: (event, fn) => { if (event === 'response') responseHandler = fn; }, off: () => {},
    goto: async () => { state.observerBeforeNavigation = !!responseHandler; return { status: () => 200 }; },
    waitForFunction: async () => {}, frameLocator: () => ({ first: () => ({ locator: () => ({ click: async () => { state.checkbox++; } }) }) }),
    locator: selector => ({ fill: async value => { state.filled = value; }, inputValue: async () => token ? 'PRIVATE' : '', click: async () => {
      assert.equal(selector, '#btnBuscar'); const post = request(page, state.filled);
      await routeHandler({ request: () => post, abort: async () => { state.aborted++; }, fallback: async () => { state.posts++; } });
      if (state.aborted) return;
      responseHandler({ request: () => post, url: () => POST, status: () => 302, headers: () => ({ location }) });
      if (location !== PAGE) return;
      responseHandler({ request: () => ({ redirectedFrom: () => post, method: () => 'GET' }), url: () => PAGE, status: () => status,
        headers: () => ({ 'content-type': 'text/html' }), body: async () => { if (delay) await new Promise(r => setTimeout(r, delay)); return Buffer.from(data); } });
    } }) };
  const context = { newPage: async () => page, route: async (_, fn) => { routeHandler = fn; }, close: async () => { state.closed++; } };
  return { state, page, options: { url, capture, handle: { browser: { newContext: async () => context } }, tier: 3, maxTimeout: 1000,
    signal: abort, audioBackoff: { remainingMs: async () => cooldown, block: () => {} }, solveNativeCaptcha: async () => { state.native++; } } };
}
test('requires the exact guest marker, whole input and capture endpoint', () => {
  assert.equal(costaRicaBrowserNumber(url,capture),number);
  for (const u of [url+'&x=1',url+'&tracking='+number,url+'#x',url.replace('https://','https://user@'),url.replace('/rastreo','/trackingweb'),url.replace(number,'short')]) assert.equal(costaRicaBrowserNumber(u,capture),null);
  assert.equal(costaRicaBrowserNumber(url,{captureResponses:[PAGE]}),null);
});
test('projects only identity and scans, excluding forms and signer', () => {
  const result=costaRicaHistory(html,number);assert.equal(result.number,number);assert.equal(result.events.length,1);assert(!JSON.stringify(result).includes('PRIVATE'));
  assert.deepEqual(costaRicaHistory(html,number+'1'),{kind:'identity_mismatch'});
  assert.deepEqual(costaRicaHistory(html.replace('</ul>','</ul><li class="d-flex justify-content-between"><span>Número de envío</span><span>'+number+'</span></li>'),number),{kind:'schema'});
});
test('only the explicit missing notice is a negative result',()=>{
  assert.deepEqual(costaRicaHistory('<html><body>El envío no se encuentra registrado en nuestro sistema</body></html>',number),{kind:'not_found'});
  assert.deepEqual(costaRicaHistory('<html><body>Error temporal</body></html>',number),{kind:'unconfirmed'});
  assert.deepEqual(costaRicaHistory('<html><body>Captcha inválido</body></html>',number),{kind:'challenge'});
  assert.deepEqual(costaRicaHistory('<html><body><div hidden>El envío no se encuentra registrado en nuestro sistema</div></body></html>',number),{kind:'unconfirmed'});
});
test('binds the complete native main-frame POST and both fresh proofs',()=>{
  const f=fixture();assert(costaRicaPostMatches(request(f.page),f.page,number));
  for(const r of [request(f.page,number.slice(0,-1)),request(f.page,number,{method:()=> 'GET'}),request(f.page,number,{frame:()=>({})}),request(f.page,number,{postData:()=>new URLSearchParams({tracking:number,_token:'PRIVATE'}).toString()}),request(f.page,number,{postData:()=>new URLSearchParams({tracking:number,_token:'PRIVATE','g-recaptcha-response':'PRIVATE'}).toString()+'&tracking='+number})])assert(!costaRicaPostMatches(r,f.page,number));
});
test('captures the verified POST redirect and its number-bound document after delayed decoding',async()=>{
  const f=fixture({delay:10});const r=await runCostaRicaBrowser(f.options);assert(f.state.observerBeforeNavigation);assert.equal(f.state.posts,1);assert.equal(f.state.closed,1);assert.equal(r.capturedResponses.length,2);assert.deepEqual(JSON.parse(r.capturedResponses[1].body),costaRicaHistory(html,number));assert.equal(r.html,'');assert.deepEqual(r.cookies,[]);assert(!JSON.stringify(r).includes('PRIVATE'));
});
test('keeps status refusals separate from history',async()=>{for(const status of [403,419,429,503]){const f=fixture({status});const r=await runCostaRicaBrowser(f.options);assert.equal(r.capturedResponses.at(-1).status,status);assert.equal(r.capturedResponses.at(-1).body,null);assert.equal(f.state.closed,1);}});
test('does not submit without verification, and never overrides the audio pause',async()=>{
  const f=fixture({token:false,cooldown:1000});const r=await runCostaRicaBrowser(f.options);assert.equal(f.state.native,0);assert.equal(f.state.checkbox,1);assert.equal(f.state.posts,0);assert.equal(r.capturedResponses.length,0);assert.equal(f.state.closed,1);
});
test('rejects an unexpected redirect without reading its body',async()=>{const f=fixture({location:'https://other.invalid/'});const r=await runCostaRicaBrowser(f.options);assert.equal(r.capturedResponses[0].error,'unexpected-redirect');assert.equal(f.state.closed,1);});
test('deadline and cancellation close the context and discard unfinished bodies',async()=>{
  const f=fixture({delay:100});f.options.maxTimeout=30;const r=await runCostaRicaBrowser(f.options);assert.equal(f.state.closed,1);assert.equal(r.capturedResponses.at(-1).body,null);
  const c=new AbortController();c.abort();const g=fixture({abort:c.signal});await runCostaRicaBrowser(g.options);assert.equal(g.state.posts,0);
});
