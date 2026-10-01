# Optional TRAWL browser service

Some carriers and universal providers require a full browser session. This image extends
[TRAWL](https://github.com/germondai/trawl) with identity-bound capture for FedEx, Royal Mail,
Australia Post, YunExpress and SF Express. The adapter checks the captured response against
the requested parcel; a solved challenge alone is not tracking history.

The service reuses browser sessions, never parcel responses. FedEx keeps one verified context
per pooled browser and discards it on expiry, mismatch or failure. Australia Post and SF
Express use fresh contexts. Optional Redis stores cookies and user agents with a TTL, not
tracking history; a failed cached session falls back to a fresh browser. Do not expose Redis.

```sh
docker build -t universal-parcel-scraper-trawl trawl
```

Keep the service on a private network and pass its URL as `trawlUrl` to the library or
`FLARESOLVERR_URL` to the CLI and HTTP server. `TRACKING_CHROMIUM_PATH` enables the separate
local Chromium transport. `REDIS_URL` configures TRAWL's optional session cache;
`AUSTRALIA_POST_BROWSER_LOCALE` overrides its browser locale, and `FFMPEG_PATH` selects
SF Express's PNG decoder.

Run `npm run test:scripts` for offline capture/session tests. Live adapter tests require a
running browser service and environment-supplied references. Browser challenges and upstream
limits can still prevent retrieval.

This derivative is [AGPL-3.0](LICENSE), separate from the core package's Apache license.
[Matching source and redistribution](SOURCE.md).
