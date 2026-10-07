# Optional TRAWL browser service

Some carriers and universal providers only answer a full browser session. This image extends
[TRAWL](https://github.com/germondai/trawl) with identity-bound capture for DHL Express, FedEx, Royal Mail,
Australia Post, YunExpress, 17TRACK and SF Express. The adapter checks the captured response against
the requested parcel. A solved challenge alone is not tracking history.

## Sessions

The service reuses browser sessions, never parcel responses. FedEx keeps one verified context
per pooled browser and discards it on expiry, mismatch or failure. Australia Post,
DHL Express and SF Express use fresh contexts. DHL Express waits for the public
page to complete verification and repeat tracking after an intermediate HTTP 428.
17TRACK submits a supplied postcode through the site's form and binds the capture to
the number and postcode in its outgoing request.

Redis is optional. It stores cookies and user agents with a TTL, not tracking history, and a
cached session that fails falls back to a fresh browser. Do not expose Redis.

## Run it

```sh
docker build -t universal-parcel-scraper-trawl trawl
```

Keep the service on a private network. Pass its URL as `trawlUrl` to the library, or as
`FLARESOLVERR_URL` to the CLI and the HTTP server. `TRACKING_CHROMIUM_PATH` enables the
separate local Chromium transport.

`REDIS_URL` configures the session cache. `AUSTRALIA_POST_BROWSER_LOCALE` overrides the
browser locale for Australia Post, and `FFMPEG_PATH` selects SF Express's PNG decoder.

## Tests

`npm run test:scripts` runs the offline capture and session tests. Live adapter tests need a
running browser service and references supplied through the environment. Browser challenges
and upstream limits can still prevent retrieval.

## License

This derivative is [AGPL-3.0](LICENSE), separate from the core package's Apache license.
[Matching source and redistribution](SOURCE.md).
