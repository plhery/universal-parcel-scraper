import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GLSHungaryTracker, glsHungaryOverviewUrl, normalizeGLSHungaryNumber, parseGLSHungaryOverview } from './adapter.js';

// Synthetic overview rows in the shape of GLS Hungary's archived public replies (see numbers.json).
const row = (tuNo: string, statusInfo: string, extra: Record<string, unknown> = {}) => ({
  postalCode: '', emailNotificationCard: false, date: '2026-01-02', natSysOwnerCode: 'HU01', owners: [], tuNo,
  progressBar: {
    level: 100, statusInfo, statusText: 'Delivered', retourFlag: false, colourIndex: 4, evtNos: ['3.0'],
    statusBar: [
      { status: 'PREADVICE', imageStatus: 'COMPLETE', imageText: 'Preadvice', statusText: '' },
      { status: statusInfo, imageStatus: 'CURRENT', imageText: 'Delivered', statusText: 'The parcel has been delivered.' },
    ],
  },
  ...extra,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('GLS Hungary input', () => {
  it('takes 10- and 11-digit national numbers and builds the Hungarian overview request', () => {
    expect(normalizeGLSHungaryNumber(' 1000 0000 01 ')).toBe('1000000001');
    expect(normalizeGLSHungaryNumber('01000000001')).toBe('01000000001');
    expect(() => normalizeGLSHungaryNumber('123456789')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeGLSHungaryNumber('ZZ12345678901')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(glsHungaryOverviewUrl('1000000001', 1)).toBe(
      'https://gls-group.eu/app/service/open/rest/HU/en/rstt029?match=1000000001&type=&caller=witt002&millis=1');
  });
});

describe('GLS Hungary overview', () => {
  it('reads the requested parcel\'s status as a summary in Budapest time', () => {
    expect(parseGLSHungaryOverview({ tuStatus: [row('1000000001', 'DELIVERED')] }, '1000000001')).toMatchObject({
      status: 'delivered', current_stage: 'delivered', canonical_tracking_number: '1000000001',
      summary_only: true, timezone: 'Europe/Budapest', events: [],
    });
    // The page's pointer to the scans below the status goes: the summary has none.
    const pointing = row('1000000001', 'DELIVERED');
    pointing.progressBar.statusBar[1]!.statusText = 'The parcel has been delivered.\nFor more information, please see the detailed shipment tracking below.';
    expect(parseGLSHungaryOverview({ tuStatus: [pointing] }, '1000000001')).toMatchObject({ last_status_text: 'The parcel has been delivered.' });
    expect(parseGLSHungaryOverview({ tuStatus: [row('01000000001', 'PREADVICE')] }, '01000000001')).toMatchObject({
      status: 'pending', current_stage: 'registered', canonical_tracking_number: '01000000001',
    });
  });

  it('binds the row to the whole requested number', () => {
    expect(() => parseGLSHungaryOverview({ tuStatus: [row('1000000002', 'DELIVERED')] }, '1000000001'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGLSHungaryOverview({ tuStatus: [row('1000000001', 'DELIVERED'), row('1000000001', 'INTRANSIT')] }, '1000000001'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // An 11-digit row is a different parcel from the 10 digits it ends with.
    expect(() => parseGLSHungaryOverview({ tuStatus: [row('01000000001', 'DELIVERED')] }, '1000000001'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('leaves an empty list, a row without a status and an unknown code open', () => {
    expect(() => parseGLSHungaryOverview({ tuStatus: [] }, '1000000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGLSHungaryOverview({ tuStatus: [{ ...row('1000000001', 'DELIVERED'), progressBar: null }] }, '1000000001'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGLSHungaryOverview({ tuStatus: [row('1000000001', 'SOMETHINGNEW')] }, '1000000001'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGLSHungaryOverview({ parcels: [] }, '1000000001')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('GLS Hungary retrieval', () => {
  it('asks the Hungarian path once and returns the parcel', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ tuStatus: [row('1000000001', 'DELIVERED')] }));
    const result = await new GLSHungaryTracker({ fetcher, now: () => 1 }).fetch('1000000001');
    expect(result.status).toBe('delivered');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(glsHungaryOverviewUrl('1000000001', 1));
  });

  it('reads only GLS\'s own not-found codes as a missing parcel', async () => {
    for (const code of ['E000', 'E206']) {
      const fetcher = vi.fn().mockResolvedValue(json({ exceptionText: 'Unfortunately there are no results.', lastError: code }, 404));
      await expect(new GLSHungaryTracker({ fetcher }).fetch('1000000001')).rejects.toMatchObject({ kind: 'not_found' });
    }
    const page = vi.fn().mockResolvedValue(new Response('<html>Not Found</html>', { status: 404 }));
    await expect(new GLSHungaryTracker({ fetcher: page }).fetch('1000000001')).rejects.toMatchObject({ kind: 'indeterminate' });
    const blocked = vi.fn().mockResolvedValue(new Response('<html>blocked</html>', { status: 403 }));
    await expect(new GLSHungaryTracker({ fetcher: blocked }).fetch('1000000001')).rejects.not.toMatchObject({ kind: 'not_found' });
    const page200 = vi.fn().mockResolvedValue(new Response('<html>maintenance</html>', { status: 200 }));
    await expect(new GLSHungaryTracker({ fetcher: page200 }).fetch('1000000001')).rejects.not.toMatchObject({ kind: 'not_found' });
  });

  it('recognizes a parcel past pre-advice, and a number GLS does not know as unknown', async () => {
    const make = (response: Response) => adapter({ fetcher: vi.fn().mockResolvedValue(response), env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
    await expect(make(json({ tuStatus: [row('1000000001', 'DELIVERED')] })).recognize!('1000000001')).resolves.toMatchObject({ known: true });
    await expect(make(json({ tuStatus: [row('1000000001', 'PREADVICE')] })).recognize!('1000000001')).resolves.toMatchObject({ known: false });
    await expect(make(json({ lastError: 'E000' }, 404)).recognize!('1000000001')).resolves.toEqual({ known: false });
    const unused = vi.fn();
    const instance = adapter({ fetcher: unused, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
    await expect(instance.recognize!('ZZ123456789')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });
});
