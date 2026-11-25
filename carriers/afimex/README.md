# Afimex

AFIMEX Paquetería y Logística is a parcel carrier in Monterrey, Nuevo León. It collects and delivers
across Mexico, tries a home delivery up to three times, and gives business customers an API. Tracked
through the form on its tracking page.

## Numbers

The site's help says the tracking code is the eight digits after the second hyphen of the label's
guide, and shows a label that prints them as the "Código de Rastreo". The adapter takes those eight
digits. Eight bare digits are a shape many carriers share, so detection does not offer Afimex and it
is tracked when chosen.

## How it works

1. `direct`: a `GET https://afimex.net/rastrea-envio` opens a Laravel session (`afimex_session` and
   `XSRF-TOKEN` cookies) and carries the form's `_token`. A `POST /rastrea-envio-resultado-v2` with
   `_token` and the code in `guias`, and the session's cookies, returns the results page. No key or
   CAPTCHA.
2. `retry`: the same two requests once more after a request that does not reach the site or times
   out.

- The results page has two views of each guide. The first is a card with the guide, its status and
  the towns it travels between; the second is a timeline of scans under each day's label. The card
  must name the code asked, and the scans come from the timeline, newest first.
- A code the tracker holds nothing for gets HTTP 200 and a card whose status is "Sin Datos", last
  updated on 1 January of year 1. That card is the only not-found.
- HTTP 419 ("Page Expired") means the session and token did not match, and is indeterminate. A bot
  check or HTTP 403 is a challenge, 503 is maintenance, and a redirect or a 404 is a moved tracker.
  The session cookie and token stay out of error details.
- Scans are staged by their whole wording in `statuses.json`.

## Notes

- The page dates each scan by its day's label and its time, with no zone. Each scan keeps that
  wall clock as `local_time`.
- A scan's location is its office. The proof of delivery, which names the recipient and holds a
  signature and the delivery place, and the remarks, which name couriers and operators, are never
  read. Nor are the origin and destination towns.

## Limitations

- Afimex prints a longer guide on the label, with the code after its second hyphen. The tracker
  takes it too, but the adapter takes only the eight-digit code.
- The form takes up to 25 guides; the adapter posts one.

## Testing

```sh
npx vitest run carriers/afimex
npm run test:carriers:live -- carriers/afimex
```

The live test reads the public sample in [`numbers.json`](numbers.json), or `AFIMEX_TRACKING_NUMBER`,
and an unknown code, or `AFIMEX_UNKNOWN_NUMBER`.
