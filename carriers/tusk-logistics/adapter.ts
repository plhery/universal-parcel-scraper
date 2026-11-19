import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { parseTuskLogistics, PROVIDER } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'tusk-logistics',
  recordsSteps: true,
  steps: ['browser'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = input.number.trim().toUpperCase();
    if (!/^TUSK[A-Z0-9]{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Invalid Tusk tracking number');
    const executablePath = environment.browserExecutablePath;
    if (!executablePath) throw new ChallengeError(PROVIDER, 'Tusk Logistics requires TRACKING_CHROMIUM_PATH');
    return runSteps({ carrier: 'tusk-logistics', budgetMs: context.budgetMs ?? 30_000,
      signal: context.signal, recorder: environment.recorder }, [{ id: 'browser', run: ({ signal, remainingMs }) =>
      withLocalBrowser({ provider: PROVIDER, executablePath, signal, timeoutMs: Math.min(60_000, Math.max(1, Math.floor(remainingMs))) },
        async ({ browser, remainingMs: browserMs }) => {
          const page = await browser.newPage();
          // The public event table does not need the separate proof-of-delivery images.
          await page.route('**/*', route => route.request().resourceType() === 'image' ? route.abort() : route.continue());
          const url = new URL('https://shipmenttracking.tusklogistics.com/');
          url.searchParams.set('trackingNumber', number);
          const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: browserMs() });
          if (!response?.ok()) {
            if (response?.status() === 403) throw new ChallengeError(PROVIDER, 'Tusk Logistics refused the guest page');
            throw new TransportError(PROVIDER, 'Tusk Logistics guest page is unavailable');
          }
          const details = page.locator('li').filter({ hasText: /^\s*Tracking Number:/i }).first();
          const missing = page.getByRole('heading', { name: 'Shipment not found!', exact: true });
          await details.or(missing).first().waitFor({ state: 'visible', timeout: browserMs() });
          const resultUrl = new URL(page.url());
          if (resultUrl.origin !== url.origin || resultUrl.searchParams.get('trackingNumber') !== number) {
            throw new IndeterminateError(PROVIDER, 'Tusk Logistics redirected the guest lookup');
          }
          return parseTuskLogistics(await page.content(), number);
        }) }]);
  },
});
