import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { isolateSiteCookies, siteCookies, siteOf } from './site-cookies.mjs';

// TRAWL's tier sources, reduced to how they open a context and read its cookies.
// The lines the patches change are kept as upstream writes them.
const upstream = {
  tier2: `async function runTier2Task(url: string, handle: Handle, session: SessionData, capture: CaptureOptions = {}, proxyUrl?: string): Promise<Tier2Result> {
  let activeContext = handle.context
  let openingContext: ReturnType<typeof newFreshContext> | undefined
  let page: Page | undefined
  let openingPage: Promise<Page> | undefined
  let cleanup: Promise<void> | undefined
  const close = () =>
    (cleanup ??= closeTemporaryContext(
      proxyUrl || capture.networkProxy ? openingContext : (openingPage ?? page),
      handle.requestBrowserReplacement,
      "tier2 page cleanup timed out",
    ))
  try {
    if (proxyUrl || capture.networkProxy) {
      const transportProxy = capture.networkProxy
        ? await capture.networkProxy(proxyUrl)
        : proxyUrl
      openingContext = newFreshContext(handle.browser, {
        proxy: transportProxy,
        onCreated: handle.noteTemporaryContext,
        requestReplacement: handle.requestBrowserReplacement,
      })
      activeContext = await openingContext
    }
    openingPage = activeContext.newPage()
    page = await openingPage
    await activeContext.addCookies(session.cookies)
    await page.goto(url)
    const cookies: Cookie[] = toCookies(await activeContext.cookies())
    return { tier: 2, status: "success", effectiveUrl: page.url(), cookies }
  } finally {
    await close()
  }
}
`,
  browser: `async function runBrowserTierTask(url: string, handle: Handle): Promise<BrowserTierResult> {
  const context = await newFreshContext(handle.browser, { onCreated: handle.noteTemporaryContext })
  try {
    const page = await context.newPage()
    await page.goto(url)
    const cookies: Cookie[] = toCookies(await context.cookies())
    return { tier: 3, status: "success", effectiveUrl: page.url(), cookies }
  } finally {
    await closeTemporaryContext(context)
  }
}
`,
};

const prelude = `import { siteCookies } from ${JSON.stringify(new URL('./site-cookies.mjs', import.meta.url).href)}
const toCookies = cookies => cookies.map(({ name, domain }) => ({ name, domain }))
const newFreshContext = async (browser, options) => { const context = await browser.newContext(options); options.onCreated?.(); return context }
const closeTemporaryContext = async target => { await (await target)?.close() }
`;

async function load(sources) {
  const body = ['tier2', 'browser'].map(file => stripTypeScriptTypes(sources[file].replace(/^import .*\n/gm, ''), { mode: 'strip' })).join('\n');
  return import(`data:text/javascript;base64,${Buffer.from(prelude + body + '\nexport { runTier2Task, runBrowserTierTask }').toString('base64')}`);
}

// A browser whose contexts keep the cookies added to them, and a shared context
// that earlier replays of other sites have left their cookies in.
function fakeBrowser(finalUrl) {
  const contexts = [];
  const context = (cookies = []) => {
    const created = { jar: [...cookies], closed: false, proxy: undefined,
      newPage: async () => ({ goto: async () => { created.jar.push({ name: 'session', domain: 'tracking.carrier.example' },
        { name: '_ga', domain: '.analytics.example' }); }, url: () => finalUrl }),
      addCookies: async added => { created.jar.push(...added); },
      cookies: async () => created.jar,
      close: async () => { created.closed = true; } };
    return created;
  };
  const shared = context([{ name: 'cf_clearance', domain: '.other-carrier.example' }]);
  const browser = { newContext: async options => { const created = context(); created.proxy = options.proxy; contexts.push(created); return created; } };
  let noted = 0;
  return { contexts, shared, handle: { context: shared, browser, noteTemporaryContext: () => { noted += 1; } }, noted: () => noted };
}

const url = 'https://www.carrier.example/track';
const session = { cookies: [{ name: 'cf_clearance', domain: '.carrier.example' }] };

test('tier 2 replays a session in its own context and returns only its site\'s cookies', async () => {
  const { runTier2Task } = await load(isolateSiteCookies(upstream));
  const browser = fakeBrowser('https://tracking.carrier.example/result');
  const result = await runTier2Task(url, browser.handle, session);
  assert.deepEqual(result.cookies, [{ name: 'cf_clearance', domain: '.carrier.example' }, { name: 'session', domain: 'tracking.carrier.example' }]);
  // The shared context is neither used nor given this site's session.
  assert.deepEqual(browser.shared.jar, [{ name: 'cf_clearance', domain: '.other-carrier.example' }]);
  assert.equal(browser.contexts.length, 1);
  assert.equal(browser.contexts[0].proxy, undefined);
  assert.equal(browser.contexts[0].closed, true);
  // A replay without a proxy does not count toward the pool's browser recycling.
  assert.equal(browser.noted(), 0);
});

test('a proxied tier 2 keeps its proxy, and the browser tiers return only the site\'s cookies', async () => {
  const { runTier2Task, runBrowserTierTask } = await load(isolateSiteCookies(upstream));
  const proxied = fakeBrowser(url);
  await runTier2Task(url, proxied.handle, session, {}, 'http://proxy.invalid:8080');
  assert.equal(proxied.contexts[0].proxy, 'http://proxy.invalid:8080');
  assert.equal(proxied.noted(), 1);
  const browser = fakeBrowser(url);
  const result = await runBrowserTierTask(url, browser.handle);
  assert.deepEqual(result.cookies, [{ name: 'session', domain: 'tracking.carrier.example' }]);
});

test('the patches stop when TRAWL\'s code has moved', () => {
  assert.throws(() => isolateSiteCookies({ ...upstream, tier2: upstream.tier2.replace('if (proxyUrl || capture.networkProxy) {', 'if (proxyUrl) {') }),
    /TRAWL tier2 changed/);
  assert.throws(() => isolateSiteCookies({ ...upstream, browser: upstream.browser.replace('await context.cookies()', 'await context.cookies([url])') }),
    /TRAWL browser changed/);
  assert.throws(() => isolateSiteCookies({ ...upstream, tier2: upstream.tier2.replace('onCreated: handle.noteTemporaryContext,', 'onCreated: handle.noteContext,') }),
    /TRAWL tier2 changed/);
});

test('a site is its registrable domain, under a country\'s second level too', () => {
  assert.equal(siteOf('www.carrier.example'), 'carrier.example');
  assert.equal(siteOf('.carrier.example'), 'carrier.example');
  assert.equal(siteOf('track.post.co.uk'), 'post.co.uk');
  assert.equal(siteOf('auspost.com.au'), 'auspost.com.au');
  assert.equal(siteOf('www.dhl.de'), 'dhl.de');
  assert.equal(siteOf('10.0.0.1'), '10.0.0.1');
  const cookies = [{ name: 'a', domain: '.post.co.uk' }, { name: 'b', domain: 'other.co.uk' }, { name: 'c', domain: 'api.post.co.uk' }, { name: 'd' }];
  assert.deepEqual(siteCookies(cookies, ['https://track.post.co.uk/x', 'about:blank']).map(cookie => cookie.name), ['a', 'c']);
  assert.deepEqual(siteCookies(cookies, ['not a url']), []);
});
