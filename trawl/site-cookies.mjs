// TRAWL's tier 2 replays a cached session inside the pool's shared browser
// context, so every site it replays leaves its cookies there, and every tier
// returns all the cookies its context holds. A reply could then carry another
// carrier's cookies, and the session cached from it would replay them. These
// patches give tier 2 its own context, as it already has through a proxy, and
// keep only the cookies of the requested or final page's site.

// Second-level labels under which a country's registrable domains sit (co.uk, com.au).
const SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'go', 'gob', 'gouv', 'gov', 'mil', 'ne', 'net', 'nic', 'or', 'org']);

/** A host's registrable domain: its last two labels, or three under a country's second level. */
export function siteOf(host) {
  const name = String(host).toLowerCase().replace(/^\.+|\.+$/g, '');
  if (name.includes(':') || /^\d+(?:\.\d+){3}$/.test(name)) return name;
  const labels = name.split('.');
  const take = labels.length > 2 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** The cookies whose domain belongs to the site of one of these page addresses. */
export function siteCookies(cookies, urls) {
  const sites = new Set(urls.flatMap(url => {
    const host = URL.canParse(url) ? new URL(url).hostname : '';
    return host ? [siteOf(host)] : [];
  }));
  return cookies.filter(cookie => typeof cookie.domain === 'string' && cookie.domain && sites.has(siteOf(cookie.domain)));
}

const PATCHES = {
  tier2: [
    ['      proxyUrl || capture.networkProxy ? openingContext : (openingPage ?? page),', '      openingContext,'],
    ['    if (proxyUrl || capture.networkProxy) {\n      const transportProxy = capture.networkProxy',
      '    {\n      const transportProxy = capture.networkProxy'],
    ['    const cookies: Cookie[] = toCookies(await activeContext.cookies())',
      '    const cookies: Cookie[] = toCookies(siteCookies(await activeContext.cookies(), [url, page.url()]))'],
  ],
  browser: [
    ['    const cookies: Cookie[] = toCookies(await context.cookies())',
      '    const cookies: Cookie[] = toCookies(siteCookies(await context.cookies(), [url, page.url()]))'],
  ],
};

/** Patches TRAWL's tier sources by file key, and stops when the code they change has moved. */
export function isolateSiteCookies(sources) {
  return Object.fromEntries(Object.entries(PATCHES).map(([file, patches]) => [file,
    'import { siteCookies } from "../utils/site-cookies.mjs"\n' + patches.reduce((source, [needle, text]) => {
      if (source.split(needle).length !== 2) throw new Error(`TRAWL ${file} changed: review the site cookie isolation`);
      return source.replace(needle, text);
    }, sources[file])]));
}
