import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { CostaRicaTracker, costaRicaUrl, COSTA_RICA_POST, adapter } from './adapter.js';
import { normalizeCostaRicaNumber, parseCostaRica } from './parser.js';
import { costaRicaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = fixture.number;
const capture = (data: unknown = fixture, extra: Record<string,unknown> = {}) => ({ url:COSTA_RICA_POST,status:200,trackingNumberSubmitted:NUMBER,headers:{},body:JSON.stringify(data),...extra });
function harness(rows=[capture()]) {
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({url:costaRicaUrl(NUMBER),html:'',statusCode:200,tier:3,cookies:[],capturedResponses:rows}),{headers:{'content-type':'application/json'}}));
  const environment={fetcher,recorder:NOOP_RECORDER,env:{},browserExecutablePath:null,trawl:new TrawlClient('https://trawl.invalid')};
  return {fetcher,environment,tracker:new CostaRicaTracker(environment)};
}
describe('Costa Rica public guest tracking',()=>{
  it('keeps native newest-first minute clocks and omits invented offsets',()=>{
    const r=parseCostaRica(fixture,NUMBER);expect(r).toMatchObject({current_stage:'delivered',last_update:null,last_update_local:'2026-03-04T12:05'});
    expect(r.events).toHaveLength(2);expect(r.events?.[1]?.local_time).toBe('2026-03-03T00:01');expect(r.events?.every(e=>!e.time)).toBe(true);
  });
  it.each(statuses.entries)('maps the real wording $wording',entry=>expect(costaRicaStage(entry.wording)).toBe(entry.stage));
  it('keeps a return in progress open',()=>{
    const r=parseCostaRica({...fixture,events:[{...fixture.events[0],description:'Tu envío se encuentra en proceso de devolución.'},...fixture.events.slice(1)]},NUMBER);
    expect(r).toMatchObject({current_stage:'exception'});expect(r.delivered_at).toBeUndefined();
  });
  it('rejects wrong identity, empty history and malformed clocks',()=>{
    expect(()=>parseCostaRica({...fixture,number:'RR999999995CR'},NUMBER)).toThrow();
    expect(()=>parseCostaRica({...fixture,events:[]},NUMBER)).toThrow(expect.objectContaining({kind:'indeterminate',name:'NoHistoryError'}));
    for(const clock of ['31/02/26 12:10 PM','04/03/26 00:10 PM','04/03/26 13:10 AM','04/03/26 01:70 AM'])expect(()=>parseCostaRica({...fixture,events:[{...fixture.events[0],clock}]},NUMBER)).toThrow(expect.objectContaining({kind:'schema'}));
  });
  it('keeps explicit absence, verification, mismatch and incomplete pages distinct',()=>{
    for(const [kind,expected] of [['not_found','not_found'],['challenge','challenge'],['identity_mismatch','indeterminate'],['unconfirmed','indeterminate'],['schema','schema']])expect(()=>parseCostaRica({kind},NUMBER)).toThrow(expect.objectContaining({kind:expected}));
    expect(normalizeCostaRicaNumber(' rr 123456785 cr ')).toBe(NUMBER);
    expect(()=>normalizeCostaRicaNumber('https://bad.invalid')).toThrow();
  });
  it('uses supplied browser transport, cancellation, budget and exact request binding',async()=>{
    const h=harness();await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({current_stage:'delivered'});expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({url:costaRicaUrl(NUMBER),skipHttp:true,maxTier:3,captureResponses:[COSTA_RICA_POST]});
    expect(h.fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);expect(adapter(h.environment).recognize).toBeUndefined();expect(adapter(h.environment).recognizeWithBrowser).toBeUndefined();
    await expect(harness([capture(fixture,{trackingNumberSubmitted:undefined})]).tracker.fetch(NUMBER)).rejects.toMatchObject({kind:'schema'});
    const c=new AbortController();c.abort();await expect(h.tracker.fetch(NUMBER,{signal:c.signal})).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER,{budgetMs:1000})).rejects.toMatchObject({kind:'budget'});
  });
  it('retains later rate limits and challenges instead of an earlier history',async()=>{
    await expect(harness([capture(),capture(null,{status:429,headers:{'retry-after':'120'}})]).tracker.fetch(NUMBER)).rejects.toMatchObject({kind:'rate_limited',retryAfterMs:120000});
    await expect(harness([capture(),capture(null,{status:403})]).tracker.fetch(NUMBER)).rejects.toMatchObject({kind:'challenge'});
    await expect(harness([capture(null,{status:302,body:null}),capture()]).tracker.fetch(NUMBER)).resolves.toMatchObject({current_stage:'delivered'});
  });
});
