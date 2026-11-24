# Commercive Parcel

Commercive Parcel ships ecommerce orders from China to the world over several shipping lines,
under one `CMV` tracking number from its warehouse to the door. Its tracker on
`commerciveparcel.com` answers that number.

## How it works

1. `direct`: asks `commerciveparcel.com/api/track?numbers={number}`, the lookup the tracker's page
   makes. It needs no session or check. The reply lists one answer per number: `found: false` with
   `not_found` is not found, and with `invalid` a number the tracker refuses.
2. `retry`: a read that fails to reach the API, or hangs, is sent once more.

- The answer must name the number asked.

## Notes

- Scan times are UTC instants, so they are kept as such.
- The tracker's status codes beyond `delivered` come from the page's script, which colours them;
  each scan's stage comes from its wording.
- Detection suggests Commercive Parcel for `CMV` and twenty digits whose last is a Luhn check over
  them, as in the tracker's example.
- The recipient's town, the delivery photos and the origin stay behind.

## Limitations

- The scans do not name the last-mile carrier or its number.
- The delivery estimate is not read; when the reply fills it, the result names it as unread.

## Testing

`npm run test:carriers:live -- carriers/commercive-parcel`

The live test tracks the example in `numbers.json`; `COMMERCIVE_PARCEL_TRACKING_NUMBER` tracks
another number, and `COMMERCIVE_PARCEL_UNKNOWN_NUMBER` checks the not-found answer.
