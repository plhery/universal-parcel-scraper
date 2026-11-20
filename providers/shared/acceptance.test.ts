import { describe, expect, it } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { readLateAcceptances } from './acceptance.js';

const result = (events: CarrierResult['events'], current = 'accepted'): CarrierResult =>
  ({ status: 'in_transit', current_stage: current, last_status_text: '', last_update: null, expected_delivery: null, events });

describe('late acceptances in a provider history', () => {
  it('reads a receipt worded as an acceptance after the parcel moved as transit', () => {
    const read = readLateAcceptances(result([
      { time: '2026-10-20T08:44:18Z', description: 'Goods have been picked up from warehouse', stage: 'accepted', stage_source: 'wording:language' },
      { time: '2026-09-05T06:39:03Z', description: 'Container loaded', stage: 'in_transit', stage_source: 'wording:language' },
      { time: '2026-09-05T02:15:35Z', description: 'The forwarder has received the goods', stage: 'accepted', stage_source: 'wording:language' },
    ]));
    expect(read.events?.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'accepted']);
    expect(read).toMatchObject({ current_stage: 'in_transit', status: 'in_transit' });
  });

  it("keeps a copy within the first movement's minute, a carrier's own map and a history with one acceptance", () => {
    const copy = result([
      { time: '2026-09-05T02:15:50Z', description: 'Accepted', stage: 'accepted', stage_source: 'wording:language' },
      { time: '2026-09-05T02:15:35Z', description: 'Picked up', stage: 'accepted', stage_source: 'wording:language' },
    ]);
    expect(readLateAcceptances(copy)).toEqual(copy);
    const mapped = result([
      { time: '2026-09-06T02:15:35Z', description: 'Parcel collected by courier', stage: 'accepted', stage_source: 'carrier_map' },
      { time: '2026-09-05T02:15:35Z', description: 'Picked up', stage: 'accepted', stage_source: 'wording:language' },
    ]);
    expect(readLateAcceptances(mapped)).toEqual(mapped);
    const single = result([
      { time: '2026-09-06T02:15:35Z', description: 'Picked up', stage: 'accepted', stage_source: 'wording:language' },
      { time: '2026-09-05T02:15:35Z', description: 'Order placed', stage: 'registered', stage_source: 'wording:language' },
    ]);
    expect(readLateAcceptances(single)).toEqual(single);
  });
});
