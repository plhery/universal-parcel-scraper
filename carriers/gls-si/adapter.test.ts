import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { GLSNationalTracker, glsNationalOverviewUrl } from '../gls-hu/national.js';
import { adapter, SLOVENIA } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import notFound from './fixtures/not-found.json' with { type: 'json' };

const NUMBER = delivered.tuStatus[0]!.tuNo;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const make = (response: Response) => {
  const fetcher = vi.fn().mockResolvedValue(response);
  return { fetcher, instance: adapter({ fetcher, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null }) };
};

describe('GLS Slovenia', () => {
  it('asks the Slovenian path of the overview and reads the public parcel\'s status as a summary', async () => {
    const { fetcher, instance } = make(json(delivered));
    await expect(instance.track({ number: NUMBER })).resolves.toMatchObject({
      status: 'delivered', current_stage: 'delivered', canonical_tracking_number: NUMBER,
      summary_only: true, timezone: 'Europe/Ljubljana', events: [], last_status_text: 'The parcel has been delivered.',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/^https:\/\/gls-group\.eu\/app\/service\/open\/rest\/SI\/en\/rstt029\?match=\d+&/);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('Referer')).toBe('https://gls-group.com/SI/sl/sledenje-posiljki/');
  });

  it('reads GLS\'s own not-found reply as not found, and only that', async () => {
    await expect(make(json(notFound, 404)).instance.track({ number: '0000000001' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(make(new Response('<html>Not Found</html>', { status: 404 })).instance.track({ number: '0000000001' }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(make(new Response('<html>maintenance</html>', { status: 200 })).instance.track({ number: '0000000001' }))
      .rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(make(json({ tuStatus: [] })).instance.track({ number: '0000000001' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('binds the row to the whole requested number', async () => {
    const other = { tuStatus: [{ ...delivered.tuStatus[0]!, tuNo: `0${NUMBER}` }] };
    await expect(make(json(other)).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('takes 10- and 11-digit numbers only', async () => {
    const { fetcher, instance } = make(json(delivered));
    await expect(instance.track({ number: '123456789' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(instance.track({ number: 'ZZ123456789SI' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(glsNationalOverviewUrl(SLOVENIA, '0000000001', 1)).toBe(
      'https://gls-group.eu/app/service/open/rest/SI/en/rstt029?match=0000000001&type=&caller=witt002&millis=1');
  });

  it('recognizes the parcel by its day in Ljubljana time', async () => {
    await expect(new GLSNationalTracker(SLOVENIA, { fetcher: vi.fn().mockResolvedValue(json(delivered)) }).recognize(NUMBER))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: `${delivered.tuStatus[0]!.date}T00:00:00`, finished: true });
  });
});
