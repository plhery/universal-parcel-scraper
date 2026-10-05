# DPD UK

DPD's United Kingdom public parcel history, using fourteen-digit parcel numbers.
Switzerland, Germany and France have separate carrier ids.

## How it works

The official page calls `apis.track.dpd.co.uk/v1/reference` with an empty
postcode to obtain a parcel handle, then reads `/parcels/{handle}` and
`/parcels/{handle}/parcelevents`. These public reads need no account, cookie or
CAPTCHA token. The adapter validates the parcel number in both lookup replies
before reading history under the returned handle.

## Notes

- Scan times have no stated timezone, including delivery-partner scans. They
  remain local clocks; the adapter does not assign a London offset.
- History stays in the page's newest-first order. Exact repeated scans are
  collapsed, and only a nonempty history produces a successful result.
- Parcel handles and recipient details remain outside the result and errors.

## Limitations

Order and collection references that require a postcode are outside this
adapter's scope. Delivery options and proof of delivery behind the postcode
form are not queried. A generic HTTP 404 does not establish parcel absence;
only the reference service's explicit unknown-reference response does.

## Testing

```sh
DPD_UK_TRACKING_NUMBER=... DPD_UK_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dpd-uk
```
