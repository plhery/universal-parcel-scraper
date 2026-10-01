<div align="center">

# Universal Parcel Scraper

**A parcel. One timeline. Your infrastructure.**

[![CI](https://github.com/plhery/universal-parcel-scraper/actions/workflows/ci.yml/badge.svg)](https://github.com/plhery/universal-parcel-scraper/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/core-Apache--2.0-blue.svg)](LICENSE)

Detect a carrier, fetch its tracking history, and get consistent stages and scan times.
A TypeScript library, a CLI, and a small HTTP server. No tracking-service account required.

<!-- GENERATED:summary -->
**105 carriers · 84 active dedicated adapters · 58 countries represented**
<!-- /GENERATED:summary -->

</div>

DHL, UPS, FedEx, USPS, Swiss Post, DPD, PostNL, and many more.
[Browse the carriers](carriers/) · [How it works](ARCHITECTURE.md) · [Add a carrier](CONTRIBUTING.md)

## Get started

Node.js 24 or newer. Install from GitHub:

```sh
npm install github:plhery/universal-parcel-scraper
npx parcel-scraper detect 1Z999AA10123456784
npx parcel-scraper track YOUR_TRACKING_NUMBER --carrier ups
```

```js
import { createTracker } from 'universal-parcel-scraper/node';

const tracker = createTracker();
const { carrier, source, result } = await tracker.track({
  number: process.env.PARCEL_NUMBER,
  carrier: 'ups',
});
console.log(carrier, source, result.current_stage, result.events);
```

Detection also works in the browser, with no network calls:

```js
import { parseTrackingInput } from 'universal-parcel-scraper';
const match = parseTrackingInput('1Z999AA10123456784'); // synthetic example
```

Direct HTTP works out of the box. Some carriers need Chromium, image processing, or the
optional [TRAWL browser service](trawl/README.md). Install the transports you need:

```sh
npm install playwright-core sharp onnxruntime-web
```

Pass `chromiumPath` or `trawlUrl` to `createTracker()`. Commercial aggregators are opt-in:
`createTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'] })`.
The default is direct adapters plus UPU for eligible postal numbers.

## How much can it track?

Carrier count tells you what the catalog knows. Tracking history tells you what a source
actually returned. Here is the recorded comparison on our **100-carrier reference set**:

<!-- GENERATED:coverage -->
| Source | Carriers with history |
| --- | ---: |
| **Universal Parcel Scraper, all fallbacks enabled** | **70 / 100** |
| Dedicated adapters alone | 51 / 100 |
| ParcelsApp | 50 / 100 |
| Postal Ninja | 41 / 100 |
| 17TRACK | 40 / 100 |
| Ship24 | 38 / 100 |
| UPU | 11 / 100 |
<!-- /GENERATED:coverage -->

Generated from [coverage.json](providers/coverage.json). These are recorded outcomes for
the comparison reference of each carrier, including partial histories; alternate samples
are excluded. This curated set is not a global market-share ranking or a live availability
promise. Old parcels expire, formats differ, and browser challenges change.
[Full results and limitations](providers/COVERAGE.md).

Hosted APIs advertise much larger carrier catalogs and handle hosting for you. This project
gives you the retrieval code, control over which sources receive a number, and no per-lookup
subscription. Catalog totals from vendors are not comparable to this reference test.

## HTTP, Docker, and Home Assistant

```sh
npx parcel-scraper serve --port 8080
curl http://127.0.0.1:8080/v1/track \
  -H 'Content-Type: application/json' \
  -d '{"number":"1Z999AA10123456784","carrier":"ups"}'
```

The server shares cached answers, spaces universal-provider calls, and limits requests.
It stores no parcel list and runs no background polling. Set `SCRAPER_TOKEN` for bearer
authentication, `SCRAPER_PROVIDERS` to select fallbacks, and `SCRAPER_DEMO_PAGE=true` for a
small one-off tracking page. [HTTP contract](server/openapi.json) · [Configuration](.env.example).

Build a container from this repository; it includes Chromium and the optional transports:

```sh
docker build -t universal-parcel-scraper .
docker run --rm -p 127.0.0.1:8080:8080 universal-parcel-scraper
```

A [Home Assistant REST sensor](examples/home-assistant.yaml) can call the same API.
[Node example](examples/node.mjs) · [Development](CONTRIBUTING.md).

## Data and limits

Lookups send the tracking number and any required postcode or capability URL to the selected
carrier. Enabled commercial fallbacks receive the number; ParcelsApp also receives a supplied
postcode. A configured TRAWL instance handles the requested pages. Browser pages can load the
carrier's or provider's challenge resources. The library has no telemetry destination;
HTTP logs contain route names and outcomes, never parcel inputs.

Consumers own polling and persistence. Respect the catalog's refresh limits and the upstream
retry advice. Carrier sites can change or refuse automated requests; some need a postcode,
a full tracking link, or an account and remain limited. Unresolved local clocks stay unresolved.

The core is [Apache-2.0](LICENSE). The optional TRAWL derivative is [AGPL-3.0](trawl/LICENSE).
Data and model credits are in [NOTICE](NOTICE).
