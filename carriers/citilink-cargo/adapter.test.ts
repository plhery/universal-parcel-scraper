import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const payload: unknown = JSON.parse(readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8'));

it('uses the Citilink domestic prefix and reads the eight confirmed iCMS milestones', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(JSON.stringify(payload)));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('citilink-cargo', '888-84379245') });

  expect(tracker.id).toBe('citilink-cargo');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [request] = fetcher.mock.calls[0]!;
  const url = new URL(String(request));
  expect(url.searchParams.get('CarrierCode')).toBe('888');
  expect(url.searchParams.get('AWBNo')).toBe('84379245');
  expect(result).toMatchObject({
    current_stage: 'in_transit', provider_code: 'RCF', last_status_text: 'Received from flight', last_update_local: '2025-05-26T16:45',
  });
  expect(result.events?.map(event => event.provider_code)).toEqual(['RCF', 'ARR', 'DEP', 'MAN', 'PRE', 'RCS', 'EXE', 'BKD']);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'RCF', location: 'BDJ' });
  expect(result.events?.at(-1)).toMatchObject({ provider_code: 'BKD', location: 'SRG' });
});

it('rejects a waybill with a different prefix before calling iCMS', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: '126-84379245' })).rejects.toMatchObject({ kind: 'invalid_input' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('requires the requested serial in the native result', () => {
  expect(() => parseTracking(payload, '90464441')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
