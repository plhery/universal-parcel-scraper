import { describe, expect, it } from 'vitest';
import { parseTrackingInput } from '../detection/parse.js';
import { resolveShopTrackingLink, shopTrackingLink, shopTrackingLinks } from './index.js';

// parcelLab's documented example reply (docs.parcellab.com, v2 checkpoints), with made-up numbers.
const DHL = '00340000000000000001';
const UPS = '1Z999AA10123456784';
const reply = (header: unknown[]) => JSON.stringify({ header, body: {} });
const documented = {
  id: '579f6444b6a1bb4fbaab5610', tracking_number: DHL,
  courier: { name: 'dhl-germany', prettyname: 'DHL', trackingurl: 'https://nolp.dhl.de/ne~~~00001', trackingurl_label: 'Klicken Sie hier' },
  last_delivery_status: { status: 'Zugestellt', code: 'Delivered' }, delay: false, exception: false,
};
// A shop's page as parcelLab serves it: the account in the plugin's options, the shipment in the link's query.
const PAGE = '<div id="parcellab-track-and-trace"></div><script>var options = { styles: true, userId: 1613380, lang: \'pl\' };</script>';
const ORDER_LINK = 'https://hm.delivery-status.com/pl/?orderNo=9900000000001&s=0000aaaa1111bbbb2222cccc3333dddd&utm_source=transactional';

function recording(answers: Record<string, () => Response>) {
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected request ${url}`);
    return answers[key]!();
  }) as typeof fetch;
  return { urls, fetcher };
}
const json = (body: string, status = 200) => () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const html = (body: string) => () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });

describe('shop tracking-page links', () => {
  it('finds parcelLab pages in prose and in an HTML email, and names the shop', () => {
    const email = `<a href="https://www2.hm.com/pl_pl/index.html">H&amp;M</a>
      <a href="https://hm.delivery-status.com/pl/?orderNo=9900000000001&amp;s=0000aaaa1111bbbb2222cccc3333dddd">Follow package</a>
      Or open https://prtl.parcellab.com/trackings/details?trackingNo=${UPS}&courier=ups.`;
    expect(shopTrackingLinks(email)).toEqual([
      { platform: 'parcellab', shop: 'hm', url: 'https://hm.delivery-status.com/pl/?orderNo=9900000000001&s=0000aaaa1111bbbb2222cccc3333dddd' },
      { platform: 'parcellab', url: `https://prtl.parcellab.com/trackings/details?trackingNo=${UPS}&courier=ups` },
    ]);
    expect(shopTrackingLink('https://www.parcellab.com/trackings/details')).toBeUndefined();
    expect(shopTrackingLink('https://hm.delivery-status.com.example.org/?trackingNo=1')).toBeUndefined();
  });

  it('reads a number and courier the link carries without a request', async () => {
    const { urls, fetcher } = recording({});
    await expect(resolveShopTrackingLink(`https://hm.delivery-status.com/de/?trackingNo=${DHL}&courier=dhl-germany`, { fetcher }))
      .resolves.toEqual({ platform: 'parcellab', shop: 'hm', status: 'resolved',
        parcels: [{ trackingNumber: DHL, carrier: 'dhl', confidence: 'high', courierCode: 'dhl-germany' }] });
    expect(urls).toEqual([]);
    // The paste parser reads the same link's number, its carrier left to the number.
    expect(parseTrackingInput(`https://hm.delivery-status.com/de/?trackingNo=${UPS}&courier=ups`))
      .toMatchObject({ trackingNumber: UPS, carrier: 'ups', source: 'link' });
  });

  it('resolves an order link through the page\'s account and parcelLab\'s checkpoints, leaving returns out', async () => {
    const { urls, fetcher } = recording({
      'https://hm.delivery-status.com/pl/': html(PAGE),
      'https://api.parcellab.com/v2/checkpoints/': json(reply([
        documented,
        { tracking_number: UPS, courier: { name: 'some-new-courier', trackingurl: `https://www.ups.com/track?tracknum=${UPS}` } },
        { tracking_number: '1Z999AA10123456791', courier: { name: 'ups' }, delivery_info: { isReturn: true } },
      ])),
    });
    await expect(resolveShopTrackingLink(ORDER_LINK, { fetcher })).resolves.toEqual({
      platform: 'parcellab', shop: 'hm', status: 'resolved', parcels: [
        { trackingNumber: DHL, carrier: 'dhl', confidence: 'high', courierCode: 'dhl-germany' },
        { trackingNumber: UPS, carrier: 'ups', confidence: 'high', courierCode: 'some-new-courier' },
      ],
    });
    // The page is asked without the link's query; the hash goes only to parcelLab's API.
    expect(urls[0]).toBe('https://hm.delivery-status.com/pl/');
    const api = new URL(urls[1]!);
    expect(Object.fromEntries(api.searchParams)).toEqual({ orderNo: '9900000000001', user: '1613380', lang: 'en', s: '0000aaaa1111bbbb2222cccc3333dddd' });
  });

  it('says why a link names no parcel', async () => {
    const withUser = `${ORDER_LINK}&u=1613380`;
    const outcome = async (answer: () => Response) =>
      (await resolveShopTrackingLink(withUser, { fetcher: recording({ 'https://api.parcellab.com/': answer }).fetcher }));
    await expect(outcome(json('Nothing found.', 404))).resolves.toMatchObject({ status: 'unresolved', reason: 'not_found', shop: 'hm' });
    await expect(outcome(json(reply([])))).resolves.toMatchObject({ reason: 'no_tracking_yet' });
    await expect(outcome(json(reply([{ courier: { name: 'dhl-germany' } }])))).resolves.toMatchObject({ reason: 'no_tracking_yet' });
    await expect(outcome(json('', 429))).resolves.toMatchObject({ reason: 'rate_limited' });
    await expect(outcome(json('', 403))).resolves.toMatchObject({ reason: 'refused' });
    await expect(outcome(json('<html>maintenance</html>'))).resolves.toMatchObject({ reason: 'unavailable' });
    await expect(outcome(() => { throw new TypeError('fetch failed'); })).resolves.toMatchObject({ reason: 'unavailable' });
    await expect(resolveShopTrackingLink('https://hm.delivery-status.com/pl/')).resolves.toMatchObject({ reason: 'unsupported' });
    await expect(resolveShopTrackingLink('https://example.org/track?trackingNo=1')).resolves.toEqual({ status: 'unresolved', reason: 'unsupported' });
    const page = recording({ 'https://hm.delivery-status.com/': html('<html>no plugin</html>') });
    await expect(resolveShopTrackingLink(ORDER_LINK, { fetcher: page.fetcher })).resolves.toMatchObject({ reason: 'unsupported' });
  });
});
