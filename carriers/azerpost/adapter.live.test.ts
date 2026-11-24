import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const direct = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The newest public record Azerpost's tracker knew; older items age out of it.
const [sample] = (corpus.records as { number: string; quarantine?: boolean; context?: { assessment?: string }; source?: { date?: string } }[])
  .filter((record) => record.context?.assessment === 'confirmed' && !record.quarantine)
  .sort((a, b) => String(b.source?.date ?? '').localeCompare(String(a.source?.date ?? '')));

describe('Azerpost live guest tracking', () => {
  it('reads the history of the newest confirmed public record', async () => {
    expect(sample).toBeDefined();
    const result = await direct().track({ number: sample!.number });
    expect(result.events?.length).toBeGreaterThan(0);
    // IPS's office wall clocks, without an offset, each at a named office.
    expect(result.events!.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && event.time === undefined && typeof event.location === 'string')).toBe(true);
    expect(result.events!.every((event) => event.stage !== undefined)).toBe(true);
    expect(result).toMatchObject({ last_status_text: expect.any(String), destination_country: expect.stringMatching(/^[A-Z]{2}$/) });
  }, 45_000);

  it('answers a well-formed unknown code with a clean not-found', async () => {
    await expect(direct().track({ number: 'RR000000005AZ' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
