#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createTracker, TrackingError } from '../facade/index.js';
import type { UniversalSource } from '../providers/types.js';
import { CARRIER_CATALOG } from '../generated/catalog.js';
import { createTrackingServer } from '../server/index.js';

const help = `Universal Parcel Scraper

  parcel-scraper detect <number, link or text>
  parcel-scraper recognize <number>
  parcel-scraper track <number> [--carrier <id>] [--postcode <value>] [--tracking-url <url>]
  parcel-scraper carriers
  parcel-scraper serve [--host <address>] [--port <port>]

SCRAPER_PROVIDERS selects comma-separated providers; default: UPU.
FLARESOLVERR_URL and TRACKING_CHROMIUM_PATH enable browser transports.
SCRAPER_TOKEN protects the HTTP API. SCRAPER_DEMO_PAGE=true enables its one-off page.`;

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const [command, ...args] = argv;
  if (!command || ['--help','-h','help'].includes(command)) { console.log(help); return 0; }
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const allowed = command === 'track' ? ['carrier','postcode','tracking-url'] : command === 'serve' ? ['host','port'] : [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const name = argument.slice(2);
    if (!allowed.includes(name) || !args[i+1] || args[i+1].startsWith('--')) throw new TypeError('Unknown or incomplete command option');
    values[name] = args[++i];
  }
  const providers = env.SCRAPER_PROVIDERS === undefined ? undefined
    : env.SCRAPER_PROVIDERS.split(',').map(value => value.trim()).filter(Boolean) as UniversalSource[];
  const options = { providers, trawlUrl: env.FLARESOLVERR_URL, chromiumPath: env.TRACKING_CHROMIUM_PATH, env };
  const tracker = createTracker(options);
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === 'carriers' && positional.length === 0) { print(CARRIER_CATALOG); return 0; }
  if (command === 'serve' && positional.length === 0) {
    const port = Number(values.port ?? env.PORT ?? 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid port');
    const host = values.host ?? env.HOST ?? '127.0.0.1';
    const server = createTrackingServer({ ...options, token: env.SCRAPER_TOKEN, demoPage: env.SCRAPER_DEMO_PAGE === 'true',
      log: record => console.error(JSON.stringify(record)) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    console.error(`Parcel tracking server listening on ${host}:${port}`);
    for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => server.close());
    return 0;
  }
  const input = positional.join(' ');
  if (!input) throw new TypeError('Supply a tracking input');
  if (command === 'detect') print(tracker.detect(input));
  else if (command === 'recognize') print(await tracker.recognize(input));
  else if (command === 'track') print(await tracker.track({ number: input, carrier: values.carrier, postcode: values.postcode, trackingUrl: values['tracking-url'] }));
  else throw new TypeError('Unknown command; use --help');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch (error) {
    console.error(error instanceof TrackingError ? JSON.stringify({ error: error.message, attempts: error.attempts, hint: error.hint })
      : error instanceof TypeError ? 'Invalid input or command; use --help' : 'Tracking could not be completed');
    process.exitCode = 1;
  }
}
