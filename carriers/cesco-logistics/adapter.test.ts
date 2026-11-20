import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const number = '001-00382127';
const page = 'https://cesco-logistics.com/tracking.php';

describe('CESCO Logistics guest tracking', () => {
  it('returns five completed local milestones in reverse chronological order', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_update: null, last_update_local: '2026-04-10T21:25:10', last_status_text: 'Order Delivered',
    });
    expect(result.events?.map(({ description, local_time, stage }) => [description, local_time, stage])).toEqual([
      ['Order Delivered', '2026-04-10T21:25:10', 'delivered'],
      ['Received to city destination', '2026-04-09T10:29:29', 'in_transit'],
      ['To city destination', '2026-04-09T10:29:29', 'in_transit'],
      ['Order pickup', '2026-04-06T14:53:00', 'accepted'],
      ['Order booking', '2026-04-02T14:30:05', 'registered'],
    ]);
  });

  it('reads the carrier-published example and honors its timestamps when the step order differs', () => {
    const result = parseTracking(fixture('carrier-example'), '001-00234567');
    expect(result.last_update_local).toBe('2019-12-12T08:23:37');
    expect(result.events?.slice(-2).map(event => event.description)).toEqual(['Order booking', 'Order pickup']);
  });

  it('ignores inactive milestones and their placeholder dates', () => {
    const finalStep = '<li class="active step0 col-lg-3"></li>';
    const index = example.lastIndexOf(finalStep);
    const future = (example.slice(0, index) + '<li class="step0 col-lg-3"></li>' + example.slice(index + finalStep.length))
      .replace('2026-04-10<br>21:25:10', '0000-00-00<br>00:00:00');
    const result = parseTracking(future, number);
    expect(result.current_stage).toBe('in_transit');
    expect(result.events).toHaveLength(4);
  });

  it('requires the requested waybill, readable dates and an explicit not-found marker', () => {
    expect(() => parseTracking(example, '999-00000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('2026-04-09', '2026-04-39'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(fixture('not-found'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('restores the waybill dash in the anonymous tracking POST', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'INVALID' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(tracker.track({ number: '00100382127' })).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://cesco-logistics.com/tracking-post.php');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Referer')).toBe(page);
    expect(String(init?.body)).toBe('q=001-00382127');
  });
});
