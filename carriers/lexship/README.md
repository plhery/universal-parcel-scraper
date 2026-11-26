# LEXSHIP

LEXSHIP is a cross-border export service of LogiLink India Pvt Ltd in Bengaluru. It consolidates
shipments from Indian small businesses and marketplace sellers and sends them abroad through
partner carriers. Its site is lexship.com.

## Numbers

The tracker takes the shipment's number as free text. Its shipments can carry a postal item number
of the network that delivers them, which belongs to that network too, so no rule offers LEXSHIP for
a number.

## Retrieval

1. `direct`: the tracking page at track.lexship.biz is a script app. Its script posts the number to
   `POST live1.lexship.com/api/tracking/new` as `{"awb_numbers":[{"parcel_id":"<number>"}]}`, with a
   bearer token written in the script, the same for every visitor. The token expires, so the adapter
   reads it from the script the page loads, keeps it for later lookups, and reads the page again
   once when the lookup refuses a kept token.
2. `retry`: the same read once more after a network failure or a hang.

- The reply lists one entry per number. The entry must be the number asked.
- An unknown number gets HTTP 200 with the status "aAWB Not Found" and an empty history, read as not
  found. An empty list, a refused token, a block page or a changed reply keep their own kinds.
- Scans have a date and a time and no place or zone. Later scans come from transit hubs and the
  destination country, so each keeps its wall clock.
- The destination country is read. The consignee's name, the origin and destination cities and the
  ship date are not.

## Links

`track.lexship.biz/?tracking=<number>` opens one shipment. The app drops the number from its address
once it looks it up, and renders an empty page for a number it does not know.

## Testing

```sh
npm run test:carriers:live -- carriers/lexship
```

`LEXSHIP_TRACKING_NUMBER` and `LEXSHIP_UNKNOWN_NUMBER` replace the public sample and the invented number.
