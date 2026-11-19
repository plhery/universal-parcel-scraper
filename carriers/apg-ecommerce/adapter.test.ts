import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { ApgEcommerceTracker } from './adapter.js';

const NUMBER = '99000005670437';
const OTHER = '99000005670438';
const headings = '<thead><tr><th>Date</th><th>Local Time</th><th>Location</th><th>Event</th><th>Event Description</th></tr></thead>';

function page(heading: string, history: string) {
  return `<title>Track my parcel | APG eCommerce</title>
    <div class="tracking-elements"><div class="tracking">
      <div class="tracking-head"><div id="tracking-title">${heading}</div></div>
      ${history}
    </div></div>`;
}

function row(date: string, time: string, event: string, country = 'HR') {
  return `<tr><td>${date}</td><td>${time}</td><td>${country}</td><td>Signed by Private Recipient</td><td>${event}</td></tr>`;
}

function history(rows: string, number = NUMBER) {
  return page(`Order No. ORD-A1-B2 / Tracking No. ${number}`,
    `<div class="traking-body"><div class="tracking-table"><table>${headings}<tbody>${rows}</tbody></table></div></div>`);
}

const trackerFor = (markup: string, status = 200) => new ApgEcommerceTracker({
  fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(markup, { status })),
});

describe('APG eCommerce guest tracker', () => {
  it('reads the whole-reference SSR timeline on its explicit GMT clock and discards the detailed event column', async () => {
    const delivered = row('01/09/26', '07:01 GMT', 'Delivered');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(history(
      row('31/08/26', '06:04 GMT', 'Out for Delivery') + delivered + delivered
      + row('31/08/26', '06:04 GMT', 'Parcel processing at final carrier Hub')
      + row('20/08/26', '20:50 GMT', 'Parcel Processed', 'GB'),
    )));
    const result = await new ApgEcommerceTracker({ fetcher }).fetch(NUMBER);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_update: '2026-09-01T07:01:00Z',
      events: [
        { description: 'Delivered', time: '2026-09-01T07:01:00Z', stage: 'delivered', location: 'HR' },
        { description: 'Out for Delivery', time: '2026-08-31T06:04:00Z', stage: 'out_for_delivery' },
        { description: 'Parcel processing at final carrier Hub', time: '2026-08-31T06:04:00Z', stage: 'in_transit' },
        { description: 'Parcel Processed', time: '2026-08-20T20:50:00Z', location: 'GB' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/ORD-A1-B2|Private Recipient/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://apgecommerce.com/track-result/?track_sequenceNo=${NUMBER}`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
  });

  it('distinguishes a bound negative from a blank result and from a different reference', async () => {
    const absence = '<div class="tracking-status-text">Sorry, order not found</div>';
    await expect(trackerFor(page(`Reference No. ${NUMBER}`, absence)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(trackerFor(page(`Reference No. ${NUMBER}`, '')).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(trackerFor(page(`Reference No. ${OTHER}`, absence)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(trackerFor(history(row('01/09/26', '07:01 GMT', 'Delivered'), OTHER)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(trackerFor(history('')).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps an attempted return distinct from final delivery', async () => {
    const result = await trackerFor(history(
      row('01/09/26', '07:01 GMT', 'Parcel In Transit back to Sender')
      + row('31/08/26', '07:24 GMT', 'Attempted Delivery'),
    )).fetch(NUMBER);
    expect(result).toMatchObject({ current_stage: 'exception', events: [{ stage: 'exception' }, { stage: 'failed_attempt' }] });
  });

  it('leaves out only a scan worded outside APG\'s wording, and marks the history incomplete', async () => {
    const result = await trackerFor(history(
      row('02/09/26', '09:00 GMT', 'Left at door 12B')
      + row('01/09/26', '08:00 GMT', 'Signed by A Neighbour')
      + row('01/09/26', '07:01 GMT', 'Delivered', 'Croatia')
      + row('31/08/26', '06:04 GMT', 'Out for Delivery'),
    )).fetch(NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', history_truncated: true, events: [
      { description: 'Delivered', time: '2026-09-01T07:01:00Z', stage: 'delivered' },
      { description: 'Out for Delivery', time: '2026-08-31T06:04:00Z', location: 'HR' },
    ] });
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/12B|Neighbour|Croatia/);
    const whole = await trackerFor(history(row('01/09/26', '07:01 GMT', 'Delivered'))).fetch(NUMBER);
    expect(whole).not.toHaveProperty('history_truncated');
  });

  it.each([
    row('31/02/26', '07:01 GMT', 'Delivered'),
    row('01/09/26', '07:01', 'Delivered'),
    row('01/09/26', '07:01 GMT', 'Signed by Private Recipient'),
    '<tr><td>01/09/26</td></tr>',
  ])('rejects changed scan data', async markup => {
    await expect(trackerFor(history(markup)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('does not report a blocked or unavailable page as a missing parcel', async () => {
    await expect(trackerFor('<title>Just a moment</title>').fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(trackerFor('Refused', 403).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(trackerFor('This route is unavailable', 404).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 404 });
  });

  it('keeps partner references with fallback and does no I/O once cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new ApgEcommerceTracker({ fetcher });
    await expect(tracker.fetch('AB123456789CD')).rejects.toMatchObject({ kind: 'indeterminate', reason: 'unsupported_reference' });
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serves an explicitly selected APG shipment through the registry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(history(row('01/09/26', '07:01 GMT', 'Delivered'))));
    const tracker = createTracker({ fetcher, providers: [] });
    const answer = await tracker.track({ number: NUMBER, carrier: 'apg-ecommerce' });
    expect(answer).toMatchObject({
      carrier: 'apg-ecommerce', source: 'apg-ecommerce', result: { current_stage: 'delivered' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
