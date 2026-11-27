/**
 * Mailing tools' click redirects. A shipping email's "Track your parcel" button often opens the mailing tool's own
 * address, which counts the click and redirects to the carrier's or the shop platform's page: Emarsys' `nrd.php`,
 * SendGrid's `ls/click` and `ss/c`, Mailchimp's `list-manage.com/track/click`, Klaviyo's `klclick`, Salesforce
 * Marketing Cloud's `?qs=` on its `click.` hosts and `exct.net`, Amazon SES' `awstrack.me`, Shopify's `/_t/c/`, and
 * the `/lnk/` links of DHL eCommerce's notification emails, on `secure.dhlecommerce.nl`.
 * Such a link is taken only with its words, and only when they read like tracking and nothing in it reads like
 * unsubscribing. Its redirects are followed with no cookie and no body read, up to the first address that is no
 * mailing tool's: that page is never loaded. Amazon SES and the `/lnk/` links write the address into the link, which
 * is read with no request.
 */
import type { ShopLinkFailure, ShopLinkResolveOptions, ShopTrackingLink } from './types.js';

/** The requests one link's redirects take: a branded address may hand over to the tool's own, which redirects. */
const MOST_HOPS = 4;

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Whether an address is a mailing tool's click redirect, by its host and path alone. */
function clickRedirect(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  return /\/u\/nrd\.php$/i.test(path) // Emarsys
    || (/^\/ls\/click\/?$/i.test(path) && url.searchParams.has('upn')) || /^\/ss\/c\/./i.test(path) // SendGrid, Klaviyo
    || (under(host, 'list-manage.com') && /^\/track\/click\/?$/i.test(path)) // Mailchimp
    || /(?:^|\.)klclick\d*\.com$/.test(host) // Klaviyo
    || ((/^(?:click|cl)\./.test(host) || under(host, 'exct.net')) && url.searchParams.has('qs')) // Salesforce Marketing Cloud
    || carriedDestination(url) !== undefined // Amazon SES
    || /^\/_t\/c\/./.test(path); // Shopify
}

// A `/lnk/` link ends with its address in URL-safe base64, which starts `aHR0` for "http":
// `secure.dhlecommerce.nl/lnk/<token>/1/<token>/aHR0cHM6Ly9teS5kaGxlY29tbWVyY2UubmwvZ28tdHJhY2stdHJhY2U_…`.
const BASE64_CARRIED = /^\/lnk\/[\w-]+\/\d+\/[\w-]+\/(aHR0[\w-]+)=*\/?$/;

/**
 * The address a link writes into itself: Amazon SES' `…awstrack.me/L0/<the address, escaped>/1/…`, and a `/lnk/`
 * link's, in base64 as its last segment.
 */
function carriedDestination(url: URL): URL | undefined {
  const escaped = under(url.hostname.toLowerCase(), 'awstrack.me') ? /^\/L0\/([^/]+)\//.exec(url.pathname)?.[1] : undefined;
  const encoded = escaped ? undefined : BASE64_CARRIED.exec(url.pathname)?.[1];
  if (!escaped && !encoded) return undefined;
  try {
    const address = escaped
      ? decodeURIComponent(escaped)
      : new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded!.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)));
    const destination = new URL(address);
    return destination.protocol === 'https:' || destination.protocol === 'http:' ? destination : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Words that say a link tracks a parcel, in the languages of the shops' emails: tracking, where it is and its status,
 * or the parcel itself. German joins its words ("Sendungsverfolgung", "Lieferstatus"). Words for following, which also
 * follow a shop on social networks ("Suivez-nous", "Volg ons"), and free shipping's ("Envío gratis") are left out:
 * every link of such an email goes through the same redirect.
 */
const TRACKING_WORDS = new RegExp([
  String.raw`(?<!\p{L})(?:track(?:ing|ed)?|trace|suivi|suivre (?:mon|ma|mes|votre|vos|le|la|les)|rastre\p{L}*|seguim\p{L}*|acompanh\p{L}*|tracci\p{L}*|spår(?:a|ning)|wo ist|where(?:'s| is)|o[uù] (?:est|en est))(?!\p{L})`,
  String.raw`tracking|verfolg|status|statut|estado|stato`,
  String.raw`colis|parcel|package|shipment|paket|pakke|sendung|pakket|zending|pacco|paquete|encomenda|przesyłk|z[aá]silk`,
].join('|'), 'iu');

/** Words of unsubscribing or managing mail, in the link's words or its address: such a link is never followed. */
const UNSUBSCRIBE_WORDS = /unsub|subscri|abonn|opt[\s_-]?out|abmeld|abbestell|d[ée]sinscri|disiscri|baja|uitschrijv|afmeld|wypis|odhl[aá]s|newsletter|preferen|präferenz|einstellung/i;

/** A mailing tool's click redirect whose words read like tracking. */
export function redirectLink(url: URL, words: string): ShopTrackingLink | undefined {
  const said = words.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!TRACKING_WORDS.test(said) || UNSUBSCRIBE_WORDS.test(said) || !clickRedirect(url)) return undefined;
  let address = url.href;
  try {
    address = decodeURIComponent(address);
  } catch {
    // Read as written.
  }
  return UNSUBSCRIBE_WORDS.test(address) ? undefined : { platform: 'redirect', url: url.href };
}

/** The address a click redirect leads to, never loaded, or why it led nowhere. */
export async function followRedirectLink(link: ShopTrackingLink, options: ShopLinkResolveOptions = {}): Promise<{ destination: URL } | { reason: ShopLinkFailure }> {
  const fetcher = options.fetcher ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const signal = () => AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(options.signal ? [options.signal] : [])]);
  const headers = { Accept: 'text/html', ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}) };
  let url = new URL(link.url);
  try {
    for (let hops = 0; clickRedirect(url); hops++) {
      const carried = carriedDestination(url);
      if (carried) {
        url = carried;
        continue;
      }
      if (hops >= MOST_HOPS) return { reason: 'unsupported' };
      const response = await fetcher(url.href, {
        headers, signal: signal(), redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return { reason: 'unsupported' };
        continue;
      }
      // A browser's fetch hides where a redirect leads.
      if (response.type === 'opaqueredirect') return { reason: 'unsupported' };
      if (response.status === 404 || response.status === 410) return { reason: 'not_found' };
      if (response.status === 401 || response.status === 403) return { reason: 'refused' };
      if (response.status === 429) return { reason: 'rate_limited' };
      // A page in place of a redirect, as a script that redirects, is not read.
      return { reason: response.ok ? 'unsupported' : 'unavailable' };
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { reason: 'unavailable' };
  }
  return { destination: url };
}
