import { afterEach, describe, expect, it } from 'vitest';
import type { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { forgetUspsBrowserSessions, readUspsPage, USPS_OUTAGE_URL } from './browser.js';

const URL_ = 'https://tools.usps.com/tracking/9400111899223397910421';
const ENDPOINT = 'ws://browser.internal:3001/' + 's'.repeat(40);

/** A browser whose navigations end as scripted: `tracking`, the blank `wrapper` or the `outage` redirect. */
function chrome(outcomes: string[]) {
  const seen = { navigations: 0, contexts: [] as { options: unknown; added: unknown[]; closed: boolean }[], waits: [] as number[],
    routed: [] as string[] };
  const browser = {
    newContext: async (options: unknown) => {
      const context = { options, added: [] as unknown[], closed: false };
      seen.contexts.push(context);
      let outcome = '';
      const page = {
        goto: async () => { outcome = outcomes[seen.navigations++] ?? 'wrapper'; if (outcome === 'broken') throw new Error(`net::ERR at ${ENDPOINT}`); },
        url: () => (outcome === 'outage' ? USPS_OUTAGE_URL : URL_),
        waitForSelector: async (_selector: string, { timeout }: { timeout: number }) => {
          seen.waits.push(timeout);
          if (outcome !== 'tracking') throw new Error('Timeout');
        },
        content: async () => `<html>${outcome}</html>`,
      };
      return {
        route: async (_pattern: string, handler: (route: unknown) => void) => {
          for (const [type, url] of [['image', 'https://www.usps.com/a.png'], ['image', 'https://tools.usps.com/akam/13/pixel_1'],
            ['font', 'https://www.usps.com/f.woff'], ['script', 'https://www.usps.com/s.js']]) {
            handler({ request: () => ({ resourceType: () => type, url: () => url }), abort: () => seen.routed.push(`skip ${type} ${new URL(url!).pathname}`),
              fallback: () => seen.routed.push(`load ${type} ${new URL(url!).pathname}`) });
          }
        },
        addCookies: async (cookies: unknown[]) => { context.added.push(...cookies); },
        newPage: async () => page,
        cookies: async () => [{ name: 'session', domain: '.usps.com' }, { name: 'other', domain: '.example.com' }],
        close: async () => { context.closed = true; },
      };
    },
  };
  const withBrowser = (async (_options: unknown, run: (session: unknown) => Promise<unknown>) =>
    run({ browser, signal: new AbortController().signal, remainingMs: () => 20_000 })) as unknown as typeof withRemoteBrowser;
  return { seen, read: () => readUspsPage({ endpoint: ENDPOINT, url: URL_, timeoutMs: 20_000, withBrowser }) };
}

afterEach(() => forgetUspsBrowserSessions());

describe('USPS private Chrome', () => {
  it('asks a new session again after two seconds and reads the tracking it then loads', async () => {
    const { seen, read } = chrome(['wrapper', 'tracking']);
    await expect(read()).resolves.toEqual({ html: '<html>tracking</html>', redirected: false });
    expect(seen.waits).toEqual([2_000, 6_000]);
    expect(seen.contexts).toMatchObject([{ options: { viewport: null }, added: [], closed: true }]);
  });

  it('loads the page without its pictures and fonts, and with the verification\'s own requests', async () => {
    const { seen, read } = chrome(['tracking']);
    await read();
    expect(seen.routed).toEqual(['skip image /a.png', 'load image /akam/13/pixel_1', 'skip font /f.woff', 'load script /s.js']);
  });

  it('gives the next lookup the accepted session\'s USPS cookies, and the time tracking takes', async () => {
    const { seen, read } = chrome(['wrapper', 'tracking', 'tracking']);
    await read();
    await expect(read()).resolves.toMatchObject({ html: '<html>tracking</html>' });
    expect(seen.contexts[1]).toMatchObject({ added: [{ name: 'session', domain: '.usps.com' }], closed: true });
    expect(seen.waits).toEqual([2_000, 6_000, 3_000]);
  });

  it('returns the page left after three navigations and forgets the session', async () => {
    const { seen, read } = chrome(['wrapper', 'tracking', 'wrapper', 'wrapper', 'wrapper', 'tracking']);
    await read();
    await expect(read()).resolves.toEqual({ html: '<html>wrapper</html>', redirected: false });
    expect(seen.navigations).toBe(5);
    await read();
    expect(seen.contexts[2]!.added).toEqual([]);
  });

  it('reports the outage redirect without reading again, and forgets the session', async () => {
    const { seen, read } = chrome(['tracking', 'outage', 'tracking']);
    await read();
    await expect(read()).resolves.toEqual({ html: '', redirected: true });
    expect(seen.navigations).toBe(2);
    await read();
    expect(seen.contexts[2]!.added).toEqual([]);
  });

  it('reports a failed navigation as transport, without the service\'s address', async () => {
    const { seen, read } = chrome(['broken']);
    const error = await read().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'TransportError', message: 'USPS browser read failed' });
    expect(String(error)).not.toContain('browser.internal');
    expect(seen.contexts[0]!.closed).toBe(true);
  });
});
