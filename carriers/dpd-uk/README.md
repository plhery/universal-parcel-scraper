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

- A number typed with the label's check character is looked up by its
  fourteen digits, as in [dpd](../dpd/README.md). The replies print that
  character too, a digit or a letter.
- Each scan row names the DPD network, a partner network abroad or the
  sender that recorded it, never a place, so events carry no location.
- The sender is the account that booked the parcel, under the name the page
  shows.
- A cancellation by the sender is an exception.
- Fourteen digits is also the shape of other DPD networks and carriers.
  Detection suggests DPD UK first for numbers starting with 1550, the range
  its tracking pages show most.
- Scan times have no stated timezone, including delivery-partner scans. They
  remain local clocks; the adapter does not assign a London offset.
- History stays in the page's newest-first order. Exact repeated scans are
  collapsed, and only a nonempty history produces a successful result.
- Parcel handles and recipient details remain outside the result and errors.

## Limitations

Order and collection references that require a postcode are outside this
adapter's scope. DPD gives a parcel number to a new parcel within months, and
the lookup then reads the newer parcel. Delivery options and proof of delivery behind the postcode
form are not queried. A generic HTTP 404 does not establish parcel absence;
only the reference service's explicit unknown-reference response does.

The [UK Android app](https://play.google.com/store/apps/details?id=com.dpd.yourdpd)
uses a separate consumer API at `https://apis.consumers.dpdgroup.co.uk`.
Its client supplies a Firebase bearer token and `dpdSession` header; saved-parcel
history uses `consumers/{consumerId}/parcels/{parcelCode}/events`. Manual
tracking resolves a number through `parcels/{number}/types/parcelOrCon` before
reading `parcels/{parcelCode}`. This account/session flow provides no simpler
replacement for the public tracking reads above.

## Testing

```sh
DPD_UK_TRACKING_NUMBER=... DPD_UK_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dpd-uk
```
