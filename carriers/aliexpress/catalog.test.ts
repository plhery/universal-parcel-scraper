import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';

const number = 'DOFR0000000000001HD';
const delivered: unknown = JSON.parse(readFileSync(new URL('./fixtures/delivered-dofr.json', import.meta.url), 'utf8'));

describe('Cainiao DOFR detection', () => {
  it('normalizes the complete identifier and routes it to Cainiao without a manual selection', async () => {
    const printed = 'dofr 0000000000001 hd';
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

  it.each(['DOFR000000000001HD', 'DOFR00000000000001HD', 'DOFR0000000000001HU', 'DOGB0000000000001HD',
    'CNFR000000000001HD', 'CNFR0000000000001HU'])(
    'leaves unsupported format %s unresolved', (value) => {
      expect(detectCarrierMatch(value).candidates).not.toContain('aliexpress');
    },
  );
});
