import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { statusMap as platformMap } from '../ubx-uk/status.js';
import platformStatuses from '../ubx-uk/statuses.json' with { type: 'json' };
import { adapter } from './adapter.js';
import { normalizeEcourierUkNumber, parseEcourierUk } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '10000001';
const script = (name: string) => `trackingdownload(${readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')});`;
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('eCourier tracking', () => {
  it('posts the number as printed to its Courier Navigator host and reads the timeline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(script('in-transit'), { headers: { 'Content-Type': 'text' } }));
    await expect(carrier(fetcher).track({ number: '1000 0001' })).resolves.toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      provider_code: '14', last_update: null, last_update_local: '2026-03-03T08:00:00', events: expect.objectContaining({ length: 3 }) });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe('https://www.ecourier.co.uk/json/search/trackingdownload');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: `consign_note=${NUMBER}` });
    expect(parseEcourierUk(script('in-transit'), NUMBER).events!.map((event) => event.stage)).toEqual(['in_transit', 'accepted', 'registered']);
  });

  it('reads the empty job list as not found, and an answer about another number as no answer', () => {
    const empty = `trackingdownload({"jobs":[],"GmapKey":null,"request":{"consign_note":"${NUMBER}"}});`;
    expect(() => parseEcourierUk(empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEcourierUk(empty.replace(NUMBER, '00000000'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('shares the platform status ids and offers no number rule', () => {
    expect(statusMap).toBe(platformMap);
    expect(statuses.entries).toEqual(platformStatuses.entries);
    for (const raw of ['', 'AB', 'AB/CD1234']) expect(() => normalizeEcourierUkNumber(raw), raw).toThrow();
    expect(normalizeEcourierUkNumber('1000 0001')).toBe(NUMBER);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('ecourier-uk');
    expect(recognitionCandidates(NUMBER).map((candidate) => candidate.carrier)).not.toContain('ecourier-uk');
  });
});
