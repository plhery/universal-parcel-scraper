# Gintracom

Gintracom is an Ecuadorian fulfilment and cash-on-delivery courier for online shops: it packs a
shop's orders and delivers them across mainland Ecuador. Tracked through the guide tracker on its
website.

## How it works

1. `trawl`: the browser service opens the tracker page for the guide,
   `ec.gintracom.site/tracking?guia=<guide>`, once Cloudflare lets it load. The page gets an
   invisible reCAPTCHA v2 token and posts it with the guide to `POST /api/v1/tracking/detalle`.
   The service's [helper](../../trawl/gintracom-browser.mjs) captures that post alone and passes
   on the guide's state and rows without the shop, the contents, the amount to collect, the
   return risk or the delivery-day choice.

- The tracker checks the token: without one, or with one reCAPTCHA refuses, it answers 422
  `Verificación de captcha fallida`. The helper then reloads the page once for a new token; a
  second refusal is a challenge. When reCAPTCHA opens its picture challenge, the helper stops and
  the adapter reports a challenge.
- A guide the tracker does not know answers 404 `No encontramos esa guía`, which is not found.
- The reply must name the guide asked.

## Notes

- Rows are staged by their wording, then by their type, which the tracker's script colours them
  by. The guide's own state decides the stage when the map knows it, as for a guide returned to
  its shop; then the newest staged row, then the step on the page's progress rail.
- Row times are a day, a Spanish month and a minute, without a year. The adapter takes the latest
  year that puts the day no later than the day after the lookup in Ecuador, as for a parcel on
  its way, and reads the clock in `America/Guayaquil`. A guide older than a year reads a year
  late.

## Limitations

- The highlighted date the page shows above the rows, a delivery estimate or a rescheduled day,
  is not read; the result lists it in `unread_estimates`.
- No recipient, signature or proof of delivery. The contact-attempt count, the pickup office and
  the choice of a delivery day are not read.
- Galápagos clocks would read an hour late; the tracker gives no zone.

## Numbers

A guide is letters and digits, ten digits on the shops' labels. The adapter takes 6 to 20
letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`ec.gintracom.site/tracking?guia=<guide>` opens one guide, and the library reads the guide from
that address.

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/gintracom/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json` through the browser service at
`FLARESOLVERR_URL`; `GINTRACOM_TRACKING_NUMBER` tracks another guide, and
`GINTRACOM_UNKNOWN_NUMBER` checks the not-found answer.
