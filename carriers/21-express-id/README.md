# 21 Express

21 Express is an Indonesian courier. Tracked through the waybill tracker on its website.

## How it works

1. `direct`: `GET /track` on `21express.co.id` for the form's token and the session cookies, then
   `POST /detail-tracking` with the token and `rec=<waybill>`, the lookup the page makes for a
   waybill's rows.
2. `retry`: one more attempt when the first cannot reach the tracker.

- The page's reCAPTCHA only gates its button. The lookup checks the form's token against the
  session the page opened and nothing else, so the adapter does not solve it.
- A waybill the tracker does not know answers with two empty lists, which is not found. A refused
  token is an inconclusive answer, as is a reply for another waybill.

## Notes

- Rows carry the tracker's status types, such as `ACCEPTANCE` or `MISSED-DELIVERY`, which its page
  shows as their description. They are staged by type.
- Each row names the shipper, the consignee, the courier and whoever scanned the parcel. The
  adapter keeps only the name on the delivery's row, as whoever took the parcel.
- Row times are wall clocks without a zone, and Indonesia has three, so they stay in
  `local_time`. The tracker writes hours and minutes with a hyphen.

## Limitations

- Rows name no place of their own; the origin and destination towns are not read.
- Only the status types seen on public samples are staged; other rows are kept without a stage.

## Numbers

A waybill is twelve digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/21-express-id/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json`; `TWENTY_ONE_EXPRESS_TRACKING_NUMBER`
tracks another waybill, and `TWENTY_ONE_EXPRESS_UNKNOWN_NUMBER` checks the not-found answer.
