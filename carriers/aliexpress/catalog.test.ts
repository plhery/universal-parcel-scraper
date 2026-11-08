import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';

const number = 'DOFR9999999999980HD';
const delivered: unknown = JSON.parse(readFileSync(new URL('./fixtures/delivered-dofr.json', import.meta.url), 'utf8'));
const inTransit = JSON.parse(readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8')) as {
  module: Record<string, unknown>[];
};

describe('Cainiao DOFR detection', () => {
  it('normalizes the complete identifier and routes it to Cainiao without a manual selection', async () => {
    const printed = 'dofr 9999999999980 hd';
    expect(parseTrackingInput(printed)).toMatchObject({
      carrier: 'aliexpress', trackingNumber: printed, confidence: 'high',
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(delivered), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const answer = await createTracker({ fetcher, providers: [] }).track({ number: printed });
    expect(answer).toMatchObject({
      carrier: 'aliexpress', source: 'aliexpress', attempts: [{ source: 'aliexpress', kind: 'ok' }],
      result: { status: 'delivered', current_stage: 'delivered', destination_country_name: 'France' },
    });
    expect(answer.result.events.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'registered']);
    expect(answer.result.events[0]).toMatchObject({
      time: '2026-03-04T10:15:00+01:00', instant: '2026-03-04T10:15:00+01:00',
    });
    expect(new Date(answer.result.events[0]!.instant!).toISOString()).toBe('2026-03-04T09:15:00.000Z');
    expect(fetcher).toHaveBeenCalledOnce();
    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.origin + requested.pathname).toBe('https://global.cainiao.com/global/detail.json');
    expect(requested.searchParams.get('mailNos')).toBe(number);
  });

  it('extracts the complete identifier from prose and links on unknown hosts', () => {
    expect(parseTrackingInput(`Tracking number: ${number}`)).toMatchObject({
      carrier: 'aliexpress', trackingNumber: number, confidence: 'high', source: 'text',
    });
    expect(parseTrackingInput(`https://example.com/parcel/${number}`)).toMatchObject({
      carrier: 'aliexpress', trackingNumber: number, confidence: 'high', source: 'link',
    });
    expect(parseTrackingInput(`Parcel reference: X${number}`).carrier).not.toBe('aliexpress');
  });

  it('routes the CNFR numbers of the same series to Cainiao', () => {
    expect(parseTrackingInput('cnfr 0000000000001 hd')).toMatchObject({ carrier: 'aliexpress', confidence: 'high' });
  });

  it("routes Maersk eCommerce's numbers for Cainiao to Cainiao, and no other client's", () => {
    for (const value of ['1MCAINIXX0000000001', '1mcainixx 00 0000 0001']) {
      expect(detectCarrierMatch(value)).toMatchObject({ carrier: 'aliexpress', confidence: 'high', candidates: ['aliexpress'] });
    }
    for (const value of ['1MCAINIXX000000001', '1MCAINIXX00000000001', '1MCAINIXY0000000001', '1MSPRDNAB0000000001']) {
      expect(detectCarrierMatch(value).candidates, value).not.toContain('aliexpress');
    }
  });

  it('routes CNG numbers to Cainiao, not to a postcode-ending Colis Privé number', () => {
    for (const value of ['CNG00123456789012', 'cng 99000000000001']) {
      expect(detectCarrierMatch(value)).toMatchObject({ carrier: 'aliexpress', confidence: 'high', candidates: ['aliexpress'] });
    }
    for (const value of ['CNG0012345678901', 'CNG001234567890123', 'CNH00123456789012', 'CNGA0123456789012']) {
      expect(detectCarrierMatch(value).confidence, value).not.toBe('high');
    }
  });

  it.each(['DOFR999999999980HD', 'DOFR00000000000001HD', 'DOFR9999999999980HU', 'DOGB0000000000001HD',
    'CNFR999999999980HD', 'CNFR0000000000001HU'])(
    'leaves unsupported format %s unresolved', (value) => {
      expect(detectCarrierMatch(value).candidates).not.toContain('aliexpress');
    },
  );
});

describe('partner numbers Cainiao follows', () => {
  // AliExpress shows the buyer SDA's waybill while the parcel is still on Cainiao's leg.
  const waybill = '000D99999980F';
  // Recognition asks the day after the fixture's last scan on Cainiao's local clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-02T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  function fetcherKnownTo(cainiao: boolean, poste = false) {
    return vi.fn<typeof fetch>((input) => Promise.resolve(new Response(JSON.stringify(
      String(input).startsWith('https://global.cainiao.com/')
        ? { ...inTransit, module: [cainiao ? { ...inTransit.module[0], mailNo: waybill, destCountry: 'Italy' }
          : { mailNo: waybill, mailNoSource: 'EXTERNAL', detailList: [] }] }
        : poste ? { idTracciatura: waybill, esitoRicerca: '3', tipoSpedizione: 'P', listaMovimenti: [{
          statoLavorazione: 'la spedizione è in transito presso il Centro di lavorazione Internazionale',
          dataOra: Date.now() - 3_600_000, luogo: 'Test Depot',
        }] }
          : { idTracciatura: waybill, esitoRicerca: '2', listaMovimenti: [] },
    ), { headers: { 'Content-Type': 'application/json' } })));
  }

  it('asks Cainiao beside Poste Italiane about an SDA waybill and files it under the one that knows it', async () => {
    expect(detectCarrierMatch(waybill)).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['aliexpress', 'poste-italiane'], preferred: [],
    });
    expect(recognitionAskedCarriers(waybill)).toEqual(['poste-italiane', 'aliexpress']);
    const fetcher = fetcherKnownTo(true);
    const tracker = createTracker({ fetcher, providers: [] });
    await expect(tracker.recognize(waybill)).resolves.toMatchObject({
      carrier: 'aliexpress', choices: [], asked: ['poste-italiane', 'aliexpress'], unanswered: [],
    });
    await expect(tracker.track({ number: waybill })).resolves.toMatchObject({
      carrier: 'aliexpress', source: 'aliexpress', result: { status: 'in_transit' },
    });
  });

  it('files a waybill both know under AliExpress and proposes Poste Italiane as its delivery carrier', async () => {
    const tracker = createTracker({ fetcher: fetcherKnownTo(true, true), providers: [] });
    await expect(tracker.recognize(waybill)).resolves.toMatchObject({ carrier: 'aliexpress', choices: [] });
    await expect(tracker.track({ number: waybill })).resolves.toMatchObject({
      carrier: 'aliexpress', source: 'aliexpress', result: { destination_country_name: 'Italy' },
      handoff: { carrier: 'poste-italiane', number: waybill, basis: 'reference', confirmed: true, result: { status: 'in_transit' } },
    });
  });

  it('files a waybill only Poste Italiane knows under Poste Italiane', async () => {
    await expect(createTracker({ fetcher: fetcherKnownTo(false, true), providers: [] }).recognize(waybill))
      .resolves.toMatchObject({ carrier: 'poste-italiane', choices: [] });
  });

  it('leaves the waybill without a carrier when neither knows it', async () => {
    await expect(createTracker({ fetcher: fetcherKnownTo(false), providers: [] }).recognize(waybill)).resolves.toEqual({
      choices: [], asked: ['poste-italiane', 'aliexpress'], unanswered: [],
    });
  });

  describe('GOFO GFUS waybills, which Cainiao follows for AliExpress parcels', () => {
    const gfus = 'GFUS00000000000001';
    const delivered = JSON.parse(readFileSync(new URL('../gofo/fixtures/delivered.json', import.meta.url), 'utf8')) as {
      data: { success: Record<string, unknown>[] };
    };
    // GOFO's answer before its first scan: the label alone.
    const labelled = (() => {
      const shipment = delivered.data.success[0]!;
      const list = shipment.trackEventList as Record<string, unknown>[];
      const label = list[list.length - 1]!;
      return { ...delivered, data: { ...delivered.data, success: [{ ...shipment, status: 'Label Created', trackEventCount: 1,
        lastTrackEvent: label, trackEventList: [label] }] } };
    })();
    const cainiaoMoving = { ...inTransit, module: [{ ...inTransit.module[0], mailNo: gfus, destCountry: 'USA' }] };
    const cainiaoUnknown = { ...inTransit, module: [{ mailNo: gfus, mailNoSource: 'EXTERNAL', detailList: [] }] };
    const fetcher = (gofo: unknown, cainiao: unknown) => vi.fn<typeof fetch>((input) => Promise.resolve(new Response(
      JSON.stringify(String(input).startsWith('https://global.cainiao.com/') ? cainiao : gofo),
      { headers: { 'Content-Type': 'application/json' } })));
    const asked = (calls: ReturnType<typeof fetcher>) => calls.mock.calls
      .map(([input]) => String(input).startsWith('https://global.cainiao.com/') ? 'aliexpress' : 'gofo');

    it("names GOFO, which issues them, and keeps Cainiao as an origin beside it", () => {
      expect(detectCarrierMatch(gfus)).toEqual({
        carrier: 'gofo', confidence: 'high', candidates: ['gofo'], preferred: [], origins: ['aliexpress'],
      });
      expect(parseTrackingInput(`gfus 0000 0000 0000 01`)).toMatchObject({ carrier: 'gofo', confidence: 'high', origins: ['aliexpress'] });
      expect(recognitionAskedCarriers(gfus)).toEqual([]);
      // Cainiao's own numbers and another carrier's alone list no origin.
      expect(detectCarrierMatch('CNG00000000000001')).not.toHaveProperty('origins');
      expect(detectCarrierMatch('GF0000000000001')).not.toHaveProperty('origins');
    });

    it("files one Cainiao follows under AliExpress while GOFO shows only the label, proposing GOFO", async () => {
      const calls = fetcher(labelled, cainiaoMoving);
      await expect(createTracker({ fetcher: calls, providers: [] }).track({ number: gfus })).resolves.toMatchObject({
        carrier: 'aliexpress', source: 'aliexpress', handoff: { carrier: 'gofo', number: gfus, confirmed: true },
      });
      expect(asked(calls)).toEqual(['gofo', 'aliexpress', 'gofo']);
    });

    it("keeps GOFO's label when Cainiao does not know the number", async () => {
      const calls = fetcher(labelled, cainiaoUnknown);
      const answer = await createTracker({ fetcher: calls, providers: [] }).track({ number: gfus });
      expect(answer).toMatchObject({ carrier: 'gofo', source: 'gofo', result: { current_stage: 'registered' } });
      expect(answer.attempts.map(({ source, kind }) => `${source} ${kind}`)).toEqual(['gofo ok', 'aliexpress not_found']);
    });

    it("asks only GOFO once it has scanned the parcel, or when the user picks it", async () => {
      const scanned = fetcher(delivered, cainiaoMoving);
      await expect(createTracker({ fetcher: scanned, providers: [] }).track({ number: gfus }))
        .resolves.toMatchObject({ carrier: 'gofo', source: 'gofo', result: { status: 'delivered' } });
      expect(asked(scanned)).toEqual(['gofo']);
      const picked = fetcher(labelled, cainiaoMoving);
      await expect(createTracker({ fetcher: picked, providers: [] }).track({ number: gfus, carrier: 'gofo' }))
        .resolves.toMatchObject({ carrier: 'gofo', source: 'gofo' });
      expect(asked(picked)).toEqual(['gofo']);
    });
  });

  it('names AliExpress for AP and fourteen digits, a Cainiao reference no other carrier prints', () => {
    for (const value of ['AP00000000000001', 'ap 0000 0000 0000 01']) {
      expect(detectCarrierMatch(value), value).toMatchObject({ carrier: 'aliexpress', confidence: 'high' });
    }
  });

  it.each(['CNUSUP00000000001', 'CNBR00000000001', 'CNMEX0000000001', 'CACAINIAO00000000001',
    'RLV00000001', 'RLDW00000001', 'JNCN000000000001', 'ECSC00AARO00000001', 'PA0000000001', 'F00000000000001',
    '9C0000I000001', '9C0000J999980', 'RTZ5P00D99999980', 'FMP5P00D99999980'])('asks Cainiao about %s', (value) => {
    expect(detectCarrierMatch(value)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: [] });
    expect(recognitionAskedCarriers(value)).toContain('aliexpress');
  });

  it.each(['AP0000000000001', 'AP000000000000001', 'AP0000000000000A', 'CNES00000000001', 'RL00000001', 'PA1000000001', 'F10000000000001', '9C0000A000001', '1C0000J000001', '3C0000J000001',
    'RTZ5P00D0000001', 'RTZ0P00D00000001', 'RTZ5X00D00000001', 'RTX5P00D00000001', '5P00D00000001',
    'FMP5P00D0000001', 'FMP1UW1AAAAAAAAA', 'GFUS0000000000001', 'GFUS000000000000001', 'GFFR00000000000001'])(
    'does not suggest AliExpress for %s', (value) => {
      expect(detectCarrierMatch(value).candidates).not.toContain('aliexpress');
    },
  );
});
