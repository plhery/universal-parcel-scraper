import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseDeliveryReceipt } from './parser.js';

// The guest receipt for the public shipment cited in numbers.json.
const receipt = readFileSync(new URL('./fixtures/receipt.html', import.meta.url), 'utf8');
const number = '0580422728';

describe('Delivery guest receipts', () => {
  it('reads the visible status and leaves the clock local', () => {
    expect(parseDeliveryReceipt(receipt, number)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ВИДАНА', last_update: null, last_update_local: '2026-08-26T17:55:00',
      summary_only: true, events: [],
    });
  });

  it.each([
    ['', 'not_found'],
    ['1', 'indeterminate'],
    ['<title>Just a moment...</title>', 'challenge'],
    ['<p>No result section</p>', 'schema'],
    [receipt.replaceAll(number, '9900000007'), 'indeterminate'],
  ])('distinguishes missing, ambiguous, blocked and malformed receipts', (reply, kind) => {
    expect(() => parseDeliveryReceipt(reply, number)).toThrow(expect.objectContaining({ kind }));
  });

  it('posts the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(receipt));
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null,
      browserExecutablePath: null, userAgent: 'Test/1.0' });
    await expect(tracker.track({ number: '№ 058042 2728' })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://www.delivery-auto.com/uk-UA/Receipts/DetailsNew', expect.objectContaining({
      method: 'POST', body: `id=${number}&delGruop=1`, redirect: 'manual', signal: expect.any(AbortSignal),
    }));
  });
});
