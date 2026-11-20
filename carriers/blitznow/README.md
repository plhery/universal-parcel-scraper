# Blitz

Blitz, formerly GrowSimplee, is an Indian delivery service for direct-to-consumer and omnichannel
sellers. It delivers same day, next day and quick-commerce orders in more than ten Indian cities.
Its site is blitznow.in. Its id carries the domain because other delivery firms use the Blitz
name.

## How it works

The adapter does what the tracking page on `track.blitznow.in` does, over plain HTTP and without a
login. It posts `{"field":"shipment","value":"{number}"}` to
`track-api.blitznow.in/whitelisttrack/api/track/` and reads the JSON reply. The reply names the
parcel's number, which binds it to the number asked.

The shipment's status is a name from a fixed list that the page's script groups into its steps; the
status map takes those names whole. The time of the last change carries its offset. For a final
status, delivered among them, the page shows the day of that change, and the adapter gives it as
the delivery time. Before then it gives the buyer's delivery estimate.

The page lists scans under its steps when the reply carries them, each with a status name and a
time. A reply without them gives the status alone. The adapter reads a scan's time only with a
stated offset and leaves out the rider's remarks.

## Numbers

Blitz numbers are `GS` and ten digits. Other carriers' numbers share that shape, so no rule claims
it.

## Limitations

- An unknown number is an HTTP 500 whose message names the failed shipment lookup; any other
  failure is reported as such, never as a missing parcel.
- The reply also holds the seller's order, the parcel's size and the recipient's masked phone
  number and postcode; the adapter keeps none of them.

## Links

`track.blitznow.in/<number>` and `track.blitznow.in/track/<number>` open one parcel. The rule for
the first takes only a segment of letters and digits that holds a digit, so the app's other pages
do not match.

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/blitznow
```

`BLITZNOW_TRACKING_NUMBER` overrides the public sample.
