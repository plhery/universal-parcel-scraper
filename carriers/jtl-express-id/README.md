# JTL Express

PT Jagad Total Logistic Express is an Indonesian courier, with branches named by their towns.
Tracked through the resi tracker on its website.

## How it works

1. `direct`: `GET /Tracking/Resitracking?resi=<resi>` on `www.jtlexpress.co.id`, the lookup the
   tracking page's script makes. The reply is JSON with the rows as HTML.
2. `retry`: one more attempt when the first cannot reach the tracker.

- The page's picture code is compared in the page with an answer the page itself carries, and
  every reply carries the next one. The lookup needs neither the code nor a session, so the
  adapter does not read the picture.
- A resi the tracker does not know answers `Resi tidak ditemukan`, which is not found. Another
  refusal is inconclusive.
- The reply must name the resi asked. The tracker matches case and hyphens, so the adapter sends
  the resi in capitals with its hyphens, as the published ones are.

## Notes

- Rows are sentences with the branch, the town or a courier in them, without codes. They are
  staged by how they start. A row's courier, or whoever took the parcel, comes after `oleh`, and
  the adapter leaves the name out.
- Row times are wall clocks without a zone, and Indonesia has three, so they stay in
  `local_time`.
- The service is read without the transit estimate after it, which the result lists in
  `unread_estimates`.

## Limitations

- Only the wording seen on public samples is staged; other rows are kept without a stage.
- The destination town and the delivery photo are not read.

## Numbers

A resi is a branch code, a month and a five-digit serial joined by hyphens, as the tracker's own
placeholder. The library hands the adapter the resi without hyphens, and the tracker knows it only
with them, so the adapter puts them back before the last nine digits. The samples and their
sources are in [`numbers.json`](numbers.json).

## Testing

```sh
npx vitest run --config vitest.carriers-live.config.ts carriers/jtl-express-id/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json`; `JTL_EXPRESS_TRACKING_NUMBER` tracks
another resi, and `JTL_EXPRESS_UNKNOWN_NUMBER` checks the not-found answer.
