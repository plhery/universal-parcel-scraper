import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from './index.js';
import { unreadEstimates } from './unread.js';

describe('unread estimates', () => {
  it('names the fields a reply fills, by their path, and none it leaves empty', () => {
    expect(unreadEstimates({
      edtStartTime: '2026-03-04 09:00', 'orderDates.max': { day: '2026-03-05' }, slot: ['', '10:00'], minutes: 90,
      empty: '  ', none: null, missing: undefined, off: false, zero: 0, list: [], record: { start: null, end: '' },
      dotnet: '0001-01-01T00:00:00', dotnetDay: '0001-01-01',
    })).toEqual({ unread_estimates: ['edtStartTime', 'orderDates.max', 'slot', 'minutes'] });
    expect(unreadEstimates({ timeWindow: null })).toEqual({});
    // A name that is no path into a reply is left out, and at most eight are named.
    expect(unreadEstimates({ 'not a path': 'x', '9lives': 'x' })).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`field${index}`, 'x']));
    expect(unreadEstimates(many).unread_estimates).toHaveLength(8);
  });

  it('keeps a result’s names once each, and drops a list that names nothing a reply can hold', () => {
    expect(normalizeCarrierResult({ status: 'in_transit', unread_estimates: ['timeWindow', 'timeWindow', 7, 'a b', 'slot'] }).unread_estimates)
      .toEqual(['timeWindow', 'slot']);
    expect(normalizeCarrierResult({ status: 'in_transit', unread_estimates: [] })).not.toHaveProperty('unread_estimates');
    expect(normalizeCarrierResult({ status: 'in_transit', unread_estimates: 'timeWindow' })).not.toHaveProperty('unread_estimates');
  });
});
