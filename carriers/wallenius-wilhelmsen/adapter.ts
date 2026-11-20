import type { Response } from 'playwright-core';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { isRecord } from '../../core/types.js';
import { cargoRows, parseTracking, provider } from './parser.js';

const portal = 'https://www.walleniuswilhelmsen.com/track-trace';
const visibility = 'https://visibility.walleniuswilhelmsen.com';
const cargos = '/visibilitywebservices/user/GUEST/cargos';

function boundSearch(response: Response, bill: string): boolean {
  if (response.url() !== visibility + cargos || response.request().method() !== 'POST') return false;
  try {
    const envelope: unknown = response.request().postDataJSON();
    return isRecord(envelope) && isRecord(envelope.request) && isRecord(envelope.request.fieldNameValue)
      && envelope.request.fieldNameValue.BOLNumber === bill;
  } catch {
    return false;
  }
}

async function replyBody(response: Response): Promise<string> {
  if (response.status() === 403) throw new ChallengeError(provider, 'Visibility refused the guest lookup');
  if (!response.ok()) throw new TransportError(provider, 'Visibility returned HTTP ' + response.status());
  const bytes = await response.body();
  if (bytes.length > 2_000_000) throw new SchemaError(provider, 'Visibility returned too much cargo data');
  return bytes.toString('utf8');
}

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['browser'],
  async track(input, context = {}) {
    const bill = input.number.trim().toUpperCase().replace(/^WLWH/, '');
    if (!/^[A-Z0-9]{6,16}$/.test(bill)) throw new InvalidInputError(provider, 'Enter a Wallenius Wilhelmsen bill of lading');
    const executablePath = environment.browserExecutablePath;
    if (!executablePath) throw new ChallengeError(provider, 'Wallenius Wilhelmsen requires TRACKING_CHROMIUM_PATH');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 35_000,
    }, [{
      id: 'browser',
      run: ({ signal, remainingMs }) => withLocalBrowser({
        provider, executablePath, signal, timeoutMs: Math.min(60_000, remainingMs),
      }, async ({ browser, remainingMs: browserMs }) => {
        const page = await browser.newPage({ locale: 'en-US' });
        await page.route('**/*', route => {
          const request = route.request();
          const host = new URL(request.url()).hostname;
          return request.resourceType() === 'image' || /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com)$/.test(host)
            ? route.abort() : route.continue();
        });
        const transports = new Map<string, Response>();
        let blocked = false;
        page.on('response', response => {
          const url = new URL(response.url());
          if (!url.hostname.endsWith('.walleniuswilhelmsen.com')) return;
          const type = response.request().resourceType();
          if (response.status() === 403 && ['document', 'xhr', 'fetch'].includes(type)) blocked = true;
          if (url.origin === visibility && /^\/visibilitywebservices\/user\/GUEST\/cargos\/\d+\/OCEAN\/transport$/.test(url.pathname)) {
            transports.set(url.pathname, response);
          }
        });
        await page.goto(portal, { waitUntil: 'domcontentloaded', timeout: browserMs() });
        const frame = page.frameLocator('iframe[src^="' + visibility + '/visibility"]');
        const field = frame.locator('input[type="text"]:visible').first();
        const rejectBlocked = () => {
          if (blocked) throw new ChallengeError(provider, 'Visibility refused the public tracking page');
        };
        await field.waitFor({ state: 'visible', timeout: browserMs() }).catch(error => {
          rejectBlocked();
          throw error;
        });
        rejectBlocked();
        const form = await frame.locator('body').innerText({ timeout: browserMs() });
        if (/verify you are human|security verification|CAPTCHA/i.test(form)) {
          throw new ChallengeError(provider, 'Visibility requests verification');
        }
        await field.fill(bill, { timeout: browserMs() });
        const [found] = await Promise.all([
          page.waitForResponse(response => boundSearch(response, bill), { timeout: browserMs() }),
          frame.locator('#visibility_ttsearch_quickSearch_searchBtn:visible').first().click({ timeout: browserMs() }),
        ]);
        const rows = cargoRows(await replyBody(found), bill);
        rejectBlocked();
        const sequence = rows.length === 1 ? rows[0]?.cargoSeqNo : undefined;
        if (typeof sequence !== 'string' || !/^\d{1,18}$/.test(sequence)) return parseTracking(rows, bill);
        const path = cargos + '/' + sequence + '/OCEAN/transport';
        const transport = transports.get(path) ?? await page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.origin === visibility && url.pathname === path && response.request().method() === 'GET';
        }, { timeout: Math.min(5000, browserMs()) }).catch(error => {
          if (error instanceof Error && error.name === 'TimeoutError') return undefined;
          throw error;
        });
        rejectBlocked();
        return parseTracking(rows, bill, transport ? await replyBody(transport) : undefined);
      }),
    }]);
  },
});
