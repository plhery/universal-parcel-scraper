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

  it('reads the numbers Narvar, AfterShip, Sendcloud and ParcelPanel links carry, with no request', async () => {
    const { urls, fetcher } = recording({});
    const resolve = (link: string) => resolveShopTrackingLink(link, { fetcher });
    // Narvar lists a shipment's numbers under the carrier the retailer booked; a number surely another's keeps its own.
    await expect(resolve(`https://tracking.narvar.com/acme/tracking/fedex?tracking_numbers=123456789012,${UPS}&order_number=1`)).resolves.toEqual({
      platform: 'narvar', shop: 'acme', status: 'resolved', parcels: [
        { trackingNumber: '123456789012', carrier: 'fedex', confidence: 'high', courierCode: 'fedex' },
        { trackingNumber: UPS, carrier: 'ups', confidence: 'high', courierCode: 'fedex' },
      ],
    });
    await expect(resolve(`https://track.aftership.com/trackings?courier=dhl-germany&tracking-numbers=${DHL}`)).resolves.toEqual({
      platform: 'aftership', status: 'resolved', parcels: [{ trackingNumber: DHL, carrier: 'dhl', confidence: 'high', courierCode: 'dhl-germany' }],
    });
    await expect(resolve(`https://www.aftership.com/track/dhl-germany/${DHL}`)).resolves.toMatchObject({ parcels: [{ carrier: 'dhl' }] });
    await expect(resolve(`https://acme.aftership.com/${UPS}?page-name=tracking`)).resolves.toEqual({
      platform: 'aftership', shop: 'acme', status: 'resolved', parcels: [{ trackingNumber: UPS, carrier: 'ups', confidence: 'high' }],
    });
    // Sendcloud's documented links (sendcloud.dev, tracking API reference).
    await expect(resolve('https://tracking.sendcloud.sc/forward?carrier=postnl&code=3SYZXG132912330&destination=NL&lang=en-us&source=NL&type=parcel&verification=5611+EM&servicepoint_verification=&created_at=2022-01-25'))
      .resolves.toEqual({ platform: 'sendcloud', status: 'resolved',
        parcels: [{ trackingNumber: '3SYZXG132912330', carrier: 'spring-gds', confidence: 'high', courierCode: 'postnl' }] });
    await expect(resolve('https://my-bakery.shipping-portal.com/tracking/?country=nl&tracking_number=3SYZXG132959174&postal_code=5611+EM'))
      .resolves.toMatchObject({ platform: 'sendcloud', shop: 'my-bakery', status: 'resolved', parcels: [{ trackingNumber: '3SYZXG132959174' }] });
    await expect(resolve(`https://www.example-shop.com/apps/parcelpanel?nums=${UPS}`)).resolves.toEqual({
      platform: 'parcelpanel', shop: 'example-shop.com', status: 'resolved', parcels: [{ trackingNumber: UPS, carrier: 'ups', confidence: 'high' }],
    });
    expect(urls).toEqual([]);
    // Pasted alone, the same links give their number to the paste parser, its carrier left to the number.
    for (const link of [
      `https://tracking.narvar.com/acme/tracking/fedex?tracking_numbers=${UPS}&order_number=1`,
      `https://acme.aftership.com/${UPS}`, `https://www.aftership.com/track/ups/${UPS}`,
      `https://track.aftership.com/trackings?courier=ups&tracking-numbers=${UPS}`,
      `https://tracking.sendcloud.sc/forward?carrier=postnl&code=${UPS}&verification=5611+EM`,
      `https://my-bakery.shipping-portal.com/tracking/?country=nl&tracking_number=${UPS}&postal_code=5611+EM`,
    ]) expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: UPS, carrier: 'ups', source: 'link' });
    expect(parseTrackingInput('https://acme.aftership.com/order-status?order-number=1001')).toMatchObject({ confidence: 'none' });
  });

  it('leaves links that name an order, not a parcel, unresolved', async () => {
    for (const [link, platform] of [
      ['https://acme.narvar.com/acme/tracking?order_number=1001', 'narvar'],
      ['https://acme.aftership.com/order-status?order-number=1001&email=buyer%40example.org', 'aftership'],
      ['https://acme.myshopify.com/apps/parcelpanel?order=1001&token=gro.elpmaxe_-_reyub', 'parcelpanel'],
      ['https://tracking.sendcloud.sc/forward?carrier=postnl', 'sendcloud'],
    ] as const) {
      await expect(resolveShopTrackingLink(link), link).resolves.toEqual({
        platform, ...(platform === 'sendcloud' ? {} : { shop: 'acme' }), status: 'unresolved', reason: 'unsupported' });
    }
    for (const other of ['https://narvar.com.example.org/acme/tracking/ups?tracking_numbers=1', 'https://example.org/apps/parcelpanelx?nums=1',
      'https://www.sendcloud.sc/forward?code=1', 'https://shipping-portal.com.example.org/tracking/?tracking_number=1']) {
      expect(shopTrackingLink(other), other).toBeUndefined();
    }
  });
});
