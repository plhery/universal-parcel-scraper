import { describe, expect, it } from 'vitest';
import { resolveShopTrackingLink, shopTrackingLink } from './index.js';

// Made-up addresses in each mailing tool's documented shape; the numbers are the shop link tests' synthetic ones.
const DHL = '00340000000000000001';
const UPS = '1Z999AA10123456784';
const HERMES = 'H1234567890123456';
const EMARSYS = 'https://link.shop.example/u/nrd.php?p=Zm9vYmFy_1_2_3_4';
const BRANDED = 'https://links.notifications.shop.example/ss/c/u001.abcDEF/4bc/xyz/h0/def';
const SENDGRID = 'https://u1234567.ct.sendgrid.net/ls/click?upn=u001.abcdef-2BGHI';
const REDIRECTS = [
  EMARSYS, BRANDED, SENDGRID,
  'https://shop.us1.list-manage.com/track/click?u=0a1b2c&id=3d4e5f&e=6a7b8c',
  'https://trk.klclick.com/ls/click?upn=u001.abc', 'https://ctrk.klclick3.com/l/01ABC',
  'https://click.e.shop.example/?qs=0a1b2c3d4e', 'https://cl.s7.exct.net/?qs=0a1b2c3d4e',
  'https://shop.example/_t/c/v3/0a1b2c3d4e',
];
const ORDER_LINK = 'https://hm.delivery-status.com/pl/?orderNo=9900000000001&s=0000aaaa1111bbbb2222cccc3333dddd';

interface Asked { url: string; init: RequestInit | undefined }

/** A fetch that answers each address it knows by its prefix and records what was asked, and how. */
function recording(answers: Record<string, () => Response>) {
  const asked: Asked[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, init });
    const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected request ${url}`);
    return answers[key]!();
  }) as typeof fetch;
  return { asked, urls: () => asked.map(({ url }) => url), fetcher };
}
const to = (location: string, status = 302) => () => new Response(null, { status, headers: { Location: location } });
const page = (status = 200) => () => new Response('<html></html>', { status, headers: { 'Content-Type': 'text/html' } });

describe('mailing tools\' click redirects', () => {
  it('takes a mailing tool\'s redirect only with words that read like tracking', () => {
    for (const link of REDIRECTS) {
      expect(shopTrackingLink(link, 'Track your parcel'), link).toEqual({ platform: 'redirect', url: link });
      // Without its words a redirect is no shop link: every link of such an email goes through it.
      expect(shopTrackingLink(link), link).toBeUndefined();
    }
    for (const words of ['Sendung verfolgen', 'Zur Sendungsverfolgung', 'Suivre mon colis', 'Suivi de livraison', 'Where is my order?',
      'Rastrear pedido', 'Traccia la spedizione', 'Volg je pakket', 'Śledź przesyłkę', 'Lieferstatus ansehen', 'TRACK ORDER']) {
      expect(shopTrackingLink(EMARSYS, words), words).toMatchObject({ platform: 'redirect' });
    }
    for (const words of ['', 'Unsubscribe', 'Abmelden', 'Se désinscrire', 'Manage preferences', 'Track your order · Unsubscribe',
      'Suivez-nous sur Instagram', 'Volg ons', 'Envío gratis', 'Spedizione gratuita', 'Shop tracksuits', 'Voir la collection', 'Shop now']) {
      expect(shopTrackingLink(EMARSYS, words), words).toBeUndefined();
    }
    // An address that says it unsubscribes, or one that is no mailing tool's redirect, is never taken.
    for (const link of ['https://shop.us1.list-manage.com/unsubscribe?u=0a1b2c&id=3d4e5f', 'https://link.shop.example/u/nrd.php?p=x&unsubscribe=1',
      'https://www.shop.example/account/orders/1001', 'https://click.e.shop.example/?other=1']) {
      expect(shopTrackingLink(link, 'Track your parcel'), link).toBeUndefined();
    }
  });

  it('follows the redirects to a carrier\'s link without loading it, and names its parcel', async () => {
    const hermes = `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${HERMES}`;
    const { asked, urls, fetcher } = recording({ [EMARSYS]: to(hermes) });
    await expect(resolveShopTrackingLink({ platform: 'redirect', url: EMARSYS }, { fetcher })).resolves.toEqual({
      platform: 'redirect', status: 'resolved', parcels: [{ trackingNumber: HERMES, carrier: 'hermes-de', confidence: 'high' }],
    });
    expect(urls()).toEqual([EMARSYS]);
    expect(asked[0]!.init).toMatchObject({ redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(asked[0]!.init?.method ?? 'GET').toBe('GET');
  });

  it('follows a branded address to the tool\'s own and hands a shop platform\'s link to its resolver', async () => {
    const { urls, fetcher } = recording({
      [BRANDED]: to(SENDGRID, 301),
      [SENDGRID]: to(`${ORDER_LINK}&u=1613380`),
      'https://api.parcellab.com/': () => new Response(JSON.stringify({ header: [{ tracking_number: UPS, courier: { name: 'ups' } }] }), { status: 200 }),
    });
    await expect(resolveShopTrackingLink({ platform: 'redirect', url: BRANDED }, { fetcher })).resolves.toEqual({
      platform: 'parcellab', shop: 'hm', status: 'resolved', parcels: [{ trackingNumber: UPS, carrier: 'ups', confidence: 'high', courierCode: 'ups' }],
    });
    // The shop's page itself is not loaded: the link names the account, and only parcelLab's API is asked.
    expect(urls().map((url) => new URL(url).host)).toEqual(['links.notifications.shop.example', 'u1234567.ct.sendgrid.net', 'api.parcellab.com']);
  });

  it('reads the address Amazon SES writes into its link with no request', async () => {
    const dhl = `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${DHL}`;
    const ses = `https://0a1b2c.r.eu-west-1.awstrack.me/L0/${encodeURIComponent(dhl)}/1/0102018c-0a1b/0a1b2c=345`;
    expect(shopTrackingLink(ses, 'Sendung verfolgen')).toEqual({ platform: 'redirect', url: ses });
    const { urls, fetcher } = recording({});
    await expect(resolveShopTrackingLink({ platform: 'redirect', url: ses }, { fetcher })).resolves.toMatchObject({
      platform: 'redirect', status: 'resolved', parcels: [{ trackingNumber: DHL, carrier: 'dhl' }],
    });
    expect(urls()).toEqual([]);
  });

  it('reads the address a `/lnk/` link writes in base64 with no request', async () => {
    const number = 'JVGL01234567890123456789';
    const page = `https://my.dhlecommerce.nl/go-track-trace?role=consumer-receive&src=dhl-notification&tc=${number}&utm_medium=email`;
    const lnk = `https://secure.dhlecommerce.nl/lnk/AUkAAAbcDEF/1/ox7LabcDEF/${btoa(page).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    expect(shopTrackingLink(lnk, 'Volg je pakket')).toEqual({ platform: 'redirect', url: lnk });
    const { urls, fetcher } = recording({});
    await expect(resolveShopTrackingLink({ platform: 'redirect', url: lnk }, { fetcher })).resolves.toMatchObject({
      platform: 'redirect', status: 'resolved', parcels: [{ trackingNumber: number, carrier: 'dhl-ecommerce-nl' }],
    });
    expect(urls()).toEqual([]);
    // A last segment that is no address is no link of this kind.
    expect(shopTrackingLink('https://secure.dhlecommerce.nl/lnk/AUkAAAbcDEF/1/ox7LabcDEF/abcDEF', 'Volg je pakket')).toBeUndefined();
  });

  it('says why a redirect names no parcel, and never loads a page that is no carrier\'s or platform\'s', async () => {
    const outcome = async (answer: () => Response) =>
      resolveShopTrackingLink({ platform: 'redirect', url: EMARSYS }, { fetcher: recording({ [EMARSYS]: answer }).fetcher });
    // A shop's own order page, or a carrier's page with no number, is left unloaded.
    const shopPage = recording({ [EMARSYS]: to('https://www.shop.example/account/orders/1001?key=abc') });
    await expect(resolveShopTrackingLink({ platform: 'redirect', url: EMARSYS }, { fetcher: shopPage.fetcher }))
      .resolves.toEqual({ platform: 'redirect', status: 'unresolved', reason: 'unsupported' });
    expect(shopPage.urls()).toEqual([EMARSYS]);
    await expect(outcome(to('https://www.myhermes.de/empfangen/sendungsverfolgung/'))).resolves.toMatchObject({ reason: 'unsupported' });
    await expect(outcome(to('mailto:service@shop.example'))).resolves.toMatchObject({ reason: 'unsupported' });
    await expect(outcome(page())).resolves.toMatchObject({ reason: 'unsupported' });
    await expect(outcome(page(404))).resolves.toMatchObject({ reason: 'not_found' });
    await expect(outcome(page(403))).resolves.toMatchObject({ reason: 'refused' });
    await expect(outcome(page(429))).resolves.toMatchObject({ reason: 'rate_limited' });
    await expect(outcome(page(503))).resolves.toMatchObject({ reason: 'unavailable' });
    await expect(outcome(() => { throw new TypeError('fetch failed'); })).resolves.toMatchObject({ reason: 'unavailable' });
    // A browser's fetch hides the destination.
    const opaque = () => ({ status: 0, type: 'opaqueredirect', ok: false, headers: new Headers(), body: null }) as unknown as Response;
    await expect(outcome(opaque)).resolves.toMatchObject({ reason: 'unsupported' });
    // A redirect that goes on redirecting stops after a few requests.
    const loop = recording({ [EMARSYS]: to(EMARSYS) });
    await expect(resolveShopTrackingLink({ platform: 'redirect', url: EMARSYS }, { fetcher: loop.fetcher })).resolves.toMatchObject({ reason: 'unsupported' });
    expect(loop.urls()).toHaveLength(4);
  });
});
