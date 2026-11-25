# Premo

Tracks parcels of Premo, owned by Bonnier and Schibsted, which delivers newspapers and e-commerce
parcels in the early morning across Greater Stockholm by electric vehicle, bike and on foot, on its
own tracking page. Parcels for the rest of Sweden go through [Early Bird](../early-bird/README.md)
and are tracked there.

## How it works

1. `direct`: `GET https://www.premo.se/paketsparning?id={number}`, the page the tracking form opens.
   It needs no cookie, key or CAPTCHA.
2. `retry`: the same read once more when Premo cannot be reached.

- The page is rendered on Premo's server. It repeats the number in its search form and lists the
  parcel's events newest first, each with Premo's code, a Swedish heading and a weekday, day and
  wall clock. The adapter keeps a page only when its form repeats the number asked.
- For a number it holds no parcel under, the page answers with HTTP 200 and "Vi kunde inte hitta
  något paket": that is not found. A page with neither events nor that answer leaves the result
  open; it is seen for Early Bird parcels Premo holds no event for.
- A Cloudflare check or a 401 or 403 is a block, a 503 maintenance, a redirect or a missing page a
  moved tracker, and any other page a changed one.

## Numbers

Premo delivers some Early Bird parcels in Greater Stockholm under Early Bird's SSCCs, and its page
answers them with Premo's own events, such as a delivery by its newspaper carrier. The public
samples are such parcels. Early Bird's rule offers Early Bird for them, so no rule offers Premo.
Premo publishes no layout of its own numbers; the adapter takes 6 to 40 letters and digits.

## Notes

- Events are staged by Premo's code; an event without one by its whole heading. Clocks are
  Stockholm wall clocks without an offset, kept local.
- The text under a heading is Premo's fixed help for that event and is not read.
- A hand-over to a partner carrier does not name the carrier, so the result names none.

## Links

The tracking page reads a number from its `id` parameter.

## Testing

```sh
npm run test:carriers:live -- carriers/premo
```

`PREMO_TRACKING_NUMBER` and `PREMO_UNKNOWN_NUMBER` replace the delivered sample and the invented number.
