import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { NotFoundError } from '../../core/errors/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ChronopostTracker } from './adapter.js';
import { normalizeChronopostNumber, parseChronopostTrackingXml } from './parser.js';
import { chronopostStage } from './status.js';

const number = 'XT123456785TS';
const fixture = readFileSync(new URL('./fixtures/international.xml', import.meta.url), 'utf8');
const envelope = (body: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
const empty = envelope(`<t:trackSkybillV2Response xmlns:t="http://cxf.tracking.soap.chronopost.fr/"><return><errorCode>0</errorCode><listEventInfoComp><skybillNumber>${number}</skybillNumber></listEventInfoComp></return></t:trackSkybillV2Response>`);

describe('Chronopost direct tracking', () => {
  it('keeps the complete international history, precise clocks and a checked partner reference', () => {
    const result = parseChronopostTrackingXml(fixture, number);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_update: '2026-01-04T18:38:28+01:00', delivery_carrier: 'dpd-de',
      delivery_tracking_number: '12345678901234E', destination_country: 'DE' });
    expect(result.events).toHaveLength(7);
    expect(result.events?.map(event => event.provider_code)).toEqual(['SM', 'TP', 'O', 'TS', 'SC', 'DB', 'DC']);
    expect(result.events?.[1]).toMatchObject({ location: 'EXAMPLE DEPOT - DE (depot 0001)', time: '2026-01-04T18:09:18+01:00' });
    expect(result.events?.[5]).toMatchObject({ location: 'EXAMPLE TOWN, FR', stage: 'accepted' });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC SHOP|EXAMPLE STREET|00000|Point de livraison|Média utilisé|Rang/);
  });

  it('keeps delivery when a later notification records activity', () => {
    const xml = fixture.replace('<code>TP </code>', '<code>DL </code>')
      .replace(/(<code>DL <\/code>[\s\S]*?<eventLabel>)[^<]+/, '$1Livraison effectuée');
    const result = parseChronopostTrackingXml(xml, number);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', stage_source: 'none' });
    expect(result.events?.[1]).toMatchObject({ stage: 'delivered', stage_source: 'wording:language' });
  });

  it('does not let a relayed code override contradictory wording', () => {
    expect(chronopostStage('DC', 'Livraison effectuée')).toMatchObject({ stage: 'delivered', source: 'wording:language' });
    expect(chronopostStage('UNKNOWN', 'Unmapped carrier message')).toEqual({ stage: 'pending', source: 'none' });
  });

  it('preserves local and invalid clocks without inventing instants', () => {
    const xml = fixture.replaceAll('+01:00', '').replace('2026-01-04T18:38:28', '2026-02-30T18:38:28+99:00');
    const result = resolveResult(parseChronopostTrackingXml(xml, number));
    expect(result.last_update).toBeNull();
    expect(result.events[0]).toMatchObject({ provider_time_text: '2026-02-30T18:38:28+99:00', instant: null });
    expect(result.events[1]).toMatchObject({ local_time: '2026-01-04T18:09:18', instant: null });
    expect(result.events.every(event => !event.time)).toBe(true);
  });

  it('sorts verified instants, including different offsets, before choosing the status', () => {
    const xml = fixture.replace('2026-01-04T18:09:18+01:00', '2026-01-05T01:09:18+09:00')
      .replace('2026-01-04T18:38:28+01:00', '2026-01-04T16:38:28Z');
    const result = parseChronopostTrackingXml(xml, number);
    expect(result.events?.map(event => event.provider_code).slice(0, 2)).toEqual(['SM', 'TP']);
  });

  it.each([
    ['GEO/12345678901234A', 'DE'], ['12345678901234E', 'DE'], ['GEO/12345678901234E', 'GB'],
  ])('does not assign the German network from %s and %s alone', (reference, country) => {
    const result = parseChronopostTrackingXml(fixture.replace('GEO/12345678901234E', reference)
      .replace('EXAMPLE CITY - DE', `EXAMPLE CITY - ${country}`), number);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBe(reference.replace('GEO/', ''));
  });

  it('refuses conflicting partner references and destination countries', () => {
    const xml = fixture.replace('<infoCompList><name>Rang</name>',
      '<infoCompList><name>Numéro partenaire</name><value>GEO/OTHER12345</value></infoCompList>'
      + '<infoCompList><name>Point de livraison</name><value>EXAMPLE CITY - CH</value></infoCompList><infoCompList><name>Rang</name>');
    const result = parseChronopostTrackingXml(xml, number);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.destination_country).toBeUndefined();
  });

  it('recognizes only a bound empty history as not-found', () => {
    expect(() => parseChronopostTrackingXml(empty, number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const xml of [empty.replace(number, 'XY123456785FR'), empty.replace('<errorCode>0', '<errorCode>9'),
      empty.replace(/<listEventInfoComp>.*?<\/listEventInfoComp>/, ''), '']) {
      expect(() => parseChronopostTrackingXml(xml, number)).toThrow(expect.objectContaining({ kind: expect.stringMatching(/schema|indeterminate/) }));
    }
  });

  it.each([
    fixture.replace(number, number + 'ABCD'),
    fixture.replace(`<skybillNumber>${number}</skybillNumber>`, `<skybillNumber>${number}</skybillNumber><skybillNumber>${number}</skybillNumber>`),
    fixture.replace('<errorCode>0</errorCode>', '<errorCode><value>0</value></errorCode>'),
    fixture.replace('<eventLabel>', '<eventLabel><value>').replace('</eventLabel>', '</value></eventLabel>'),
    fixture.replace('http://cxf.tracking.soap.chronopost.fr/', 'https://example.invalid/'),
    fixture.replace('<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE soap:Envelope [<!ENTITY test "invalid">]>'),
    fixture.replace('</soap:Body>', '<return/></soap:Body>'),
    fixture.slice(0, -40),
  ])('rejects malformed, ambiguous or mismatched replies', xml => {
    expect(() => parseChronopostTrackingXml(xml, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('bounds the XML body and event count', () => {
    expect(() => parseChronopostTrackingXml(' '.repeat(2_000_001), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const scan = '<events><eventLabel>Colis en cours d\'acheminement</eventLabel></events>';
    expect(() => parseChronopostTrackingXml(empty.replace('<skybillNumber>', scan.repeat(501) + '<skybillNumber>'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('distinguishes SOAP faults and blocked HTML from missing parcels', () => {
    expect(() => parseChronopostTrackingXml(envelope('<s:Fault><faultstring>Unavailable</faultstring></s:Fault>'), number))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChronopostTrackingXml('<html><title>Just a moment...</title></html>', number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('shares the whole-number validation and asks Chronopost for a generic postal number over HTTP', async () => {
    expect(normalizeChronopostNumber('xt 123456785 ts')).toBe(number);
    expect(normalizeChronopostNumber('12345678901234E')).toBe('12345678901234E');
    for (const invalid of ['12345678901234A', '6A00000000000', '12345678901234', number + '<tag>']) {
      expect(() => normalizeChronopostNumber(invalid)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(recognitionCandidates(number).map(candidate => candidate.carrier)).toContain('chronopost');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(number)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-01-04T17:38:28.000Z' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('uses the supplied transport, user agent, signal and remaining budget and records one lookup', async () => {
    const steps: unknown[] = [];
    const lookups: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture));
    const tracker = new ChronopostTracker({ fetcher, userAgent: 'Synthetic host/1.0',
      recorder: { step: step => steps.push(step), lookup: lookup => lookups.push(lookup) } });
    await tracker.fetch(number, { signal: new AbortController().signal, budgetMs: 900 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS');
    expect(init).toMatchObject({ method: 'POST', headers: { 'User-Agent': 'Synthetic host/1.0' }, cache: 'no-store', signal: expect.any(AbortSignal) });
    expect(init!.body).toContain(`<skybillNumber>${number}</skybillNumber>`);
    expect(steps).toHaveLength(1);
    expect(lookups).toHaveLength(1);
  });

  it.each([404, 410, 429, 500])('preserves a rejected HTTP %i as an upstream failure', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(status === 500
      ? envelope('<s:Fault/>') : '<html>Unavailable</html>', { status, headers: { 'Retry-After': '30' } }));
    await expect(new ChronopostTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: status === 429 ? 'rate_limited' : 'indeterminate' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not accept an empty success-shaped body on HTTP 500 as not-found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(empty, { status: 500 }));
    await expect(new ChronopostTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
  });

  it('returns negative recognition only for invalid inputs or the bound unknown reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(empty));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(number)).resolves.toEqual({ known: false });
    fetcher.mockImplementation(async () => new Response(empty.replace(number, 'XY123456785FR')));
    await expect(instance.recognize!(number)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('does not make a request after caller cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const reason = new Error('cancelled');
    await expect(new ChronopostTracker({ fetcher }).fetch(number, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([true, false])('routes the checked foreign reference to its own adapter, confirmed=%s', async known => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture));
    const partner = vi.fn().mockImplementation(async () => {
      if (!known) throw new NotFoundError('DPD Germany');
      return { status: 'in_transit', events: [{ time: '2026-01-04T18:09:18+01:00',
        description: 'Your parcel is on its way', stage: 'in_transit' }] };
    });
    const registry = new AdapterRegistry({ factories: { chronopost: adapter,
      'dpd-de': () => ({ id: 'dpd-de', steps: ['direct'], track: partner }) },
    carriers: { chronopost: 'chronopost', 'dpd-de': 'dpd-de' } },
    { fetcher, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, env: {} });
    const response = await createTracker({ registry, providers: [] }).track({ number, carrier: 'chronopost' });
    expect(response).toMatchObject({ carrier: 'chronopost', source: 'chronopost', handoff: {
      carrier: 'dpd-de', number: '12345678901234E', confirmed: known }, attempts: [
      { source: 'chronopost', kind: 'ok' }, { source: 'dpd-de', kind: known ? 'ok' : 'not_found' },
    ] });
    expect(response.result.events).toHaveLength(7);
    expect(Boolean(response.handoff?.result)).toBe(known);
    expect(partner).toHaveBeenCalledWith({ number: '12345678901234E' },
      expect.objectContaining({ signal: expect.any(AbortSignal), budgetMs: expect.any(Number) }));
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
