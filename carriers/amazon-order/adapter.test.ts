import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { amazonShareToken, validateAmazonShareUrl } from '../../core/catalog/urls.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { universalPlan } from '../../providers/plan.js';
import { adapter, RECHECK_PAUSE_MS } from './adapter.js';
import { parseAmazonOrder } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
// A fixture is read with the token of the link it was archived under.
const parse = (name: string, store: string) => {
  const html = fixture(name);
  return parseAmazonOrder(html, /shareToken=([0-9a-f-]{36})/.exec(html)![1]!, store);
};
const numberOf = (token: string) => token.replace(/-/g, '').toUpperCase();
const canonical = (store: string, token: string) =>
  `https://www.amazon.${store}/progress-tracker/package/share/?unauthenticated=1&vt=SHARED_PACKAGE_TRACKING&shareToken=${token}`;
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

// Public samples: each fixture is an archived shared page, trimmed to what the parser reads.
const UK = 'e9e3e310-44d7-4f1b-80b9-d10b8fe0a887';
const FR = 'e253332d-7088-43ae-8056-02fbbba45691';
const SYNTHETIC = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

describe('Amazon order tracking links', () => {
  it("binds the Share tracking link to its token and stores Amazon's own address for it", () => {
    const number = numberOf(SYNTHETIC);
    const shared = `https://www.amazon.co.uk/progress-tracker/package/share/?ref=ppx_pt2_mob_ap_st_rcpt&shareToken=${SYNTHETIC}&vt=SHARED_PACKAGE_TRACKING`;
    expect(amazonShareToken(number)).toBe(SYNTHETIC);
    expect(validateAmazonShareUrl(shared, number)).toBe(canonical('co.uk', SYNTHETIC));
    expect(validateAmazonShareUrl(shared.replace('www.', '').replace(SYNTHETIC, SYNTHETIC.toUpperCase()), number)).toBe(canonical('co.uk', SYNTHETIC));
    expect(normalizeCarrierInputs('amazon-order', number, shared, '')).toMatchObject({ trackingUrl: canonical('co.uk', SYNTHETIC) });
    // The link is kept as pasted; its inputs are normalized when the parcel is saved.
    expect(parseTrackingInput(shared)).toMatchObject({ trackingNumber: SYNTHETIC, carrier: 'amazon-order', trackingUrl: shared });
    expect(normalizeCarrierInputs('amazon-order', SYNTHETIC, shared, '')).toMatchObject({ trackingUrl: canonical('co.uk', SYNTHETIC) });
    expect(parseTrackingInput(shared.replace('amazon.co.uk', 'amazon.co.jp'))).toMatchObject({ carrier: 'amazon-order' });
    for (const invalid of [shared.replace('https:', 'http:'), shared.replace('amazon.co.uk', 'amazon.example'),
      shared.replace('www.amazon.co.uk', 'user@www.amazon.co.uk'), shared.replace('www.amazon.co.uk', 'www.amazon.co.uk:8443'),
      shared.replace('/progress-tracker/package/share/', '/gp/your-account/order-history'), shared.replace(SYNTHETIC, 'not-a-token'),
      `${shared}&shareToken=${SYNTHETIC}`, shared.replace(SYNTHETIC, UK), 'amazon.co.uk']) {
      expect(() => validateAmazonShareUrl(invalid, number), invalid).toThrow(TypeError);
    }
  });

  it('asks no universal provider about a link token', () => {
    expect(universalPlan({ carriers: ['amazon-order'], trackingNumber: numberOf(SYNTHETIC), enablePostalNinja: true }).sources).toEqual([]);
    // Nor about the token alone, as an integration may pass it on: only a carrier named for the number is asked.
    expect(universalPlan({ trackingNumber: numberOf(SYNTHETIC) }).sources).toEqual([]);
    expect(universalPlan({ carriers: ['fedex'], trackingNumber: numberOf(SYNTHETIC) }).sources.length).toBeGreaterThan(0);
  });
});

describe('Amazon shared tracking pages', () => {
  it('reads the status and names the third-party carrier, which the page gives without its number', () => {
    expect(parse('colis-prive-in-transit', 'fr')).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Livraison prévue demain', provider_code: 'IN_TRANSIT', summary_only: true, last_update: null,
      delivery_carrier: 'colis-prive', events: [],
    });
    expect(parse('usps-delivered', 'com')).toMatchObject({
      current_stage: 'delivered', provider_code: 'DELIVERED', delivery_carrier: 'usps',
    });
    expect(parse('lost', 'es')).toMatchObject({
      status: 'exception', current_stage: 'exception', provider_code: 'LOST',
      last_status_text: 'Delivery date currently unavailable', delivery_carrier: 'correos-express',
    });
  });

  it("reads a seller's carrier, never the seller, and names no carrier for Amazon's own delivery or a name it does not know", () => {
    const seller = parse('seller-yunexpress', 'ca');
    expect(seller).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Arriving 4 September - 9 September', delivery_carrier: 'yunexpress' });
    const amazon = parse('delivered-by-amazon', 'co.uk');
    expect(amazon).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered 31 October' });
    expect(amazon).not.toHaveProperty('delivery_carrier');
    expect(parse('ctt-es', 'es')).not.toHaveProperty('delivery_carrier');
  });

  it("lets an exception override the status, and the milestone stand in when Amazon has no news", () => {
    expect(parse('refused', 'co.jp')).toMatchObject({
      status: 'exception', current_stage: 'exception', provider_code: 'REFUSED_BY_CUSTOMER', last_status_text: 'Cancelled',
    });
    expect(parse('no-information', 'com')).toMatchObject({
      current_stage: 'in_transit', provider_code: 'NO_INFORMATION_AVAILABLE', last_status_text: 'Now arriving tomorrow',
    });
  });

  it('confirms the page was opened with the same token', () => {
    expect(() => parseAmazonOrder(fixture('colis-prive-in-transit'), SYNTHETIC, 'fr')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAmazonOrder(fixture('colis-prive-in-transit').replace('SHARED_PACKAGE_TRACKING"}', 'ORDER_DETAILS"}'), FR, 'fr'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAmazonOrder('<html><body>Your Orders</body></html>', FR, 'fr')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Amazon order adapter', () => {
  const number = numberOf(FR);
  const link = `https://www.amazon.fr/progress-tracker/package/share/?shareToken=${FR}&vt=SHARED_PACKAGE_TRACKING`;

  it("opens Amazon's address for the link and returns the page's status", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(fixture('colis-prive-in-transit')));
    await expect(createTracker({ fetcher, env: {}, providers: [] }).track({ number, carrier: 'amazon-order', trackingUrl: link }))
      .resolves.toMatchObject({ carrier: 'amazon-order', source: 'amazon-order', result: { current_stage: 'in_transit', delivery_carrier: 'colis-prive' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(canonical('fr', FR));
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('keeps a refused link, a robot check and upstream failures apart, without the token in any error', async () => {
    const signIn = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { Location: '/gp/css/order-history/' } }));
    const refused: unknown = await carrier(signIn).track({ number, trackingUrl: link }).catch(value => value);
    expect(refused).toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(signIn).toHaveBeenCalledTimes(1);
    // Too little time for the pause after a robot check: it is the answer.
    const captcha = vi.fn<typeof fetch>(async () => new Response('<form action="/errors/validateCaptcha"></form>', { status: 503 }));
    await expect(carrier(captcha).track({ number, trackingUrl: link }, { budgetMs: 5_000 })).rejects.toMatchObject({ kind: 'challenge' });
    expect(captcha).toHaveBeenCalledTimes(1);
    const failed = vi.fn<typeof fetch>(async () => { throw new Error(link); });
    const network: unknown = await carrier(failed).track({ number, trackingUrl: link }).catch(value => value);
    expect(network).toMatchObject({ kind: 'transport' });
    const gateway = vi.fn<typeof fetch>(async () => new Response('gateway error', { status: 502 }));
    const upstream: unknown = await carrier(gateway).track({ number, trackingUrl: link }).catch(value => value);
    for (const error of [refused, network, upstream]) {
      expect(JSON.stringify(error)).not.toContain(FR);
      expect(String((error as Error).cause ?? '')).not.toContain(FR);
    }
    expect(() => carrier(signIn).track({ number })).toThrow(expect.objectContaining({ kind: 'input_required' }));
    expect(() => carrier(signIn).track({ number, trackingUrl: link.replace(FR, SYNTHETIC) })).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it("asks once more ten seconds after Amazon's robot check, which answers a run of requests from one address", async () => {
    vi.useFakeTimers();
    try {
      const lookup = async (fetcher: typeof fetch) => {
        const answer = carrier(fetcher).track({ number, trackingUrl: link }, { budgetMs: 20_000 }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(RECHECK_PAUSE_MS);
        return answer;
      };
      const robot = () => new Response('<form action="/errors/validateCaptcha"></form>', { status: 503 });
      const cleared = vi.fn<typeof fetch>().mockResolvedValueOnce(robot()).mockResolvedValueOnce(new Response(fixture('colis-prive-in-transit')));
      await expect(lookup(cleared)).resolves.toMatchObject({ current_stage: 'in_transit' });
      expect(cleared).toHaveBeenCalledTimes(2);
      const blocked = vi.fn<typeof fetch>(async () => robot());
      await expect(lookup(blocked)).resolves.toMatchObject({ kind: 'challenge' });
      expect(blocked).toHaveBeenCalledTimes(2);
      const waf = vi.fn<typeof fetch>(async () => new Response('<script>window.awsWafCookieDomainList = [];</script>', { status: 202 }));
      await expect(lookup(waf)).resolves.toMatchObject({ kind: 'challenge' });
      expect(waf).toHaveBeenCalledTimes(2);
      // An unknown or expired link is not asked again.
      const signIn = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { Location: '/gp/css/order-history/' } }));
      await expect(lookup(signIn)).resolves.toMatchObject({ kind: 'indeterminate' });
      expect(signIn).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
