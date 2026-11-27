import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

// Public archived replies of GLS Slovenia's tracking service. GLS drops a parcel after some months,
// so the test needs one of them to be found, not all.
const confirmed = (corpus.records as { number: string; context?: { assessment?: string } }[])
  .filter(record => record.context?.assessment === 'confirmed').map(record => record.number);

describe('GLS Slovenia live retrieval', () => {
  it('reads the status of a public parcel from the Slovenian overview', async () => {
    const results = [];
    for (const number of confirmed) {
      try {
        results.push(await instance().track({ number }));
      } catch (error) {
        expect(error).toMatchObject({ kind: 'not_found' });
      }
    }
    // When every record has expired, add a fresher public report to numbers.json.
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result).toMatchObject({ summary_only: true, timezone: 'Europe/Ljubljana' });
  }, 60_000);

  it('reads a number GLS Slovenia never issued as not found', async () => {
    // GLS Slovenia knows a parcel under 0000000001.
    await expect(instance().track({ number: '0000000002' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
