import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, guestSession, trackRequest } from './adapter.js';
import { normalizeAlaskaAirCargoNumber, parseAlaskaAirCargo } from './parser.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// Live replies for public waybills: one flown from San Diego through Seattle to Philadelphia, one the portal no longer holds.
const notified = fixture('notified.html');
const notFound = fixture('not-found.html');
const notFoundMessages = JSON.stringify(JSON.parse(fixture('not-found-messages.json')));
const token = 'guest-form-token';
const landing = (html = `<form id="login_form_top"><input type="hidden" name="_token_" id="_token_" value="${token}" /></form>`,
  cookies = ['JSESSIONID=guest-session; Path=/icargoportal; HttpOnly', 'companyId=AS; Path=/icargoportal; HttpOnly',
    'companyId=AS; Path=/icargoportal; HttpOnly', 'AWSALB=balancer; Path=/']) =>
  new Response(html, { headers: [['Content-Type', 'text/html;charset=UTF-8'], ...cookies.map(cookie => ['Set-Cookie', cookie] as [string, string])] });
const fragment = (html: string, headers: Record<string, string> = {}, status = 200) =>
  new Response(html, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...headers } });
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (reply: Response, number = '027-37241971') =>
  tracker(vi.fn<typeof fetch>().mockResolvedValueOnce(landing()).mockResolvedValueOnce(reply)).track({ number });

/** The live reply as `change` edits it. */
function edited(change: (page: ReturnType<typeof load>) => void): string {
  const page = load(notified);
  change(page);
  return page.html();
}
const latestStatus = (page: ReturnType<typeof load>, wording: string, station?: string) => {
  const item = page('.panel-heading.LATEST').closest('.panel').find('ul.feeds > li');
  item.find('.cont-col2 .desc .label').text(wording);
  if (station) item.find('.cont-col1 .label').text(station);
};

describe('Alaska Air Cargo air waybills', () => {
  it('takes the 027 prefix with or without a separator, or the serial alone, and checks its digit', () => {
    expect(normalizeAlaskaAirCargoNumber('027-37241971')).toBe('02737241971');
    expect(normalizeAlaskaAirCargoNumber('027 37241971')).toBe('02737241971');
    expect(normalizeAlaskaAirCargoNumber('02737241971')).toBe('02737241971');
    expect(normalizeAlaskaAirCargoNumber('37241971')).toBe('02737241971');
    expect(() => normalizeAlaskaAirCargoNumber('027-37241972')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeAlaskaAirCargoNumber('173-37241971')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('opens a guest session on the portal, then posts the tracking form for the whole waybill with its token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(landing()).mockResolvedValueOnce(fragment(notified));
    const result = await tracker(fetcher).track({ number: '027-37241971' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://alaska-icargo.ibsplc.aero/icargoportal/portal/loginFlow');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://alaska-icargo.ibsplc.aero/icargoportal/portal/trackshipments?fragments=trackPanel');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('cookie')).toBe('JSESSIONID=guest-session; companyId=AS; AWSALB=balancer');
    expect(headers.get('_token_')).toBe(token);
    expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('trackingFilterWidgetModel.trackingFilterVO.awbVO.shipmentPrefixArray[0]')).toBe('027');
    expect(body.get('trackingFilterWidgetModel.trackingFilterVO.awbVO.documentNumberArray[0]')).toBe('37241971');
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map', last_status_text: 'Notified',
      last_update: null, last_update_local: '2025-04-17T17:16',
    });
    expect(result).not.toHaveProperty('provider_code');
  });

  it('keeps the tracker’s order, each station’s wall clock and the station apart from the step', () => {
    const { events = [] } = parseAlaskaAirCargo(notified, null, '02737241971');
    expect(events[0]).toMatchObject({
      description: 'Shipment received from flight', original_description: 'Shipment received from flight at PHL', location: 'PHL',
      local_time: '2025-04-17T17:16', stage: 'in_transit',
    });
    expect(events[1]).toMatchObject({ description: 'Notified', location: 'PHL', stage: 'ready_for_pickup' });
    expect(events.find(event => event.description === 'Shipment Transferred-in')).toMatchObject({ location: 'SEA', stage: 'in_transit' });
    expect(events.find(event => event.description === 'Manifested')).not.toHaveProperty('stage');
    // Each booked flight gives a Booked row at the same minute; it is kept once.
    expect(events.filter(event => event.description === 'Booked')).toEqual([
      expect.objectContaining({ location: 'SAN', local_time: '2025-04-16T11:14', stage: 'registered' }),
    ]);
    expect(events.at(-1)).toMatchObject({ description: 'Booked' });
    expect(events).toHaveLength(10);
    expect(events.some(event => event.time)).toBe(false);
  });

  it('reads a delivery after other rows as the status', () => {
    const delivered = edited(page => {
      const last = page('.flightList').last();
      const row = last.clone();
      row.find('h5').eq(0).text('Delivered at PHL');
      row.find('h5').eq(1).text('17-Apr 2025 | 19:02');
      last.after(row);
      latestStatus(page, 'Delivered');
    });
    const result = parseAlaskaAirCargo(delivered, null, '02737241971');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2025-04-17T19:02',
    });
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', location: 'PHL', stage: 'delivered' });
  });

  it('files a notice away from the waybill’s destination in transit', () => {
    const elsewhere = notified.replace('>SAN>PHL<', '>SAN>BOS<');
    expect(parseAlaskaAirCargo(elsewhere, null, '02737241971')).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Notified',
    });
  });

  it('keeps the stage before a manifest the tracker shows as the latest status', () => {
    const manifested = edited(page => {
      page('.flightList').slice(8).remove();
      latestStatus(page, 'Manifested', 'SEA');
    });
    expect(parseAlaskaAirCargo(manifested, null, '02737241971')).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipment Transferred-in', last_update_local: '2025-04-16T18:47',
    });
  });

  it('requires the requested waybill before reading its history', () => {
    expect(() => parseAlaskaAirCargo(notified, null, '02737241982')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the portal’s not-found message for the requested waybill as not found', async () => {
    await expect(lookup(fragment(notFound, { applicationmessages: notFoundMessages }), '027-92025382'))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fragment(notFound, { applicationmessages: notFoundMessages }), '027-37241971'))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('reads a listed waybill without history as known without history', () => {
    const empty = edited(page => { page('.flightList').remove(); });
    expect(() => parseAlaskaAirCargo(empty, null, '02737241971')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('does not take a refused session, a lapsed one or an unreadable reply for a missing waybill', async () => {
    const refused = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<title>Just a moment...</title>', { status: 403 }));
    await expect(tracker(refused).track({ number: '027-37241971' })).rejects.toMatchObject({ kind: 'challenge' });
    expect(() => guestSession('<html><title>iCargo</title></html>', ['JSESSIONID=guest-session'])).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => guestSession(`<input name="_token_" value="${token}">`, [])).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'session_rejected' }));
    await expect(lookup(fragment('<html><title>HTTP Status 400 – Bad Request</title></html>', {}, 400))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fragment('<title>Attention Required! | Cloudflare</title>', {}, 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fragment('<title>Just a moment...</title>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fragment(notFound, { 'session-expired': 'true' }))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(lookup(fragment(notFound))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fragment(notFound, { applicationmessages: 'not json' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('posts the form fields the tracking page’s script serializes', () => {
    expect([...new URLSearchParams(trackRequest('02737241971')).keys()]).toEqual([
      'trackingFilterWidgetModel.trackingFilterVO.screenStatus', 'trackingFilterWidgetModel.trackingFilterVO.shipments',
      'trackingFilterWidgetModel.trackingFilterVO.awbVO.shipmentPrefix', 'trackingFilterWidgetModel.trackingFilterVO.fromScreen',
      'trackingFilterWidgetModel.trackingFilterVO.trackingShipmentId', 'trackingFilterWidgetModel.trackingFilterVO.awbVO.shipmentPrefixArray[0]',
      'trackingFilterWidgetModel.trackingFilterVO.awbVO.documentNumberArray[0]', 'tokenString',
    ]);
  });
});
