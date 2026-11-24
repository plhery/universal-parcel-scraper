# GLS Netherlands

Parcels GLS delivers in the Netherlands, including those sent from other GLS countries, and
parcels GLS Netherlands takes in. Tracked through the API behind gls-info.nl's tracking page,
with the delivery postcode.

## How it works

1. `direct`: one `GET https://apm.gls.nl/api/tracktrace/v1/{number}/postalcode/{postcode}/details/en-GB`,
   as the tracking page asks it. It needs no key, cookie or referer. The JSON reply holds the
   parcel's numbers, its scans oldest first, the delivery window and where it was delivered.

- Every lookup needs the postcode, but a parcel can be added without one. Without it the
  adapter makes no request and reports `input_required`, and enabled universal providers answer
  instead. A Dutch postcode is sent without its space; any other goes as typed, in capitals.
- A wrong postcode, an unknown number and a parcel GLS no longer shows all get an empty HTTP 204.
  That does not show the parcel is missing, so it is `indeterminate` (`portal_not_found`).
- The reply files the parcel under its parcel number, its GLS number and its track ID. It counts
  only when the number asked is one of them.
- Failures drop the request and response details `fetchBounded` attaches: the address holds the
  postcode.
- There is no recognition, since every lookup needs the postcode.

## Notes

- Scans carry a clock without an offset, sometimes with milliseconds. They keep it as
  `local_time` and are read on Amsterdam's clock with `time_zone_basis: carrier`, scans abroad
  too: the reply names a country for each scan but no zone.
- Each scan's event and reason numbers are its `provider_code`, as `3/0`. A reason the map does
  not list takes its event's stage.
- `2/124` is a ParcelShop scan both ways. With the scan's state 4 the parcel was left there for
  the recipient and is ready for pickup; otherwise the sender handed it in, and GLS has accepted
  it. A parcel at a ParcelShop or locker is delivered when the recipient collects it (`3/8960`
  at a locker).
- Notices move nothing: a day not taken out on a round, the recipient's instructions and
  locker bookings, a locker's message, the label's payment and GLS's message to the recipient.
- The delivery window has offsets on the delivery day and is a wall clock before it. A single
  time at midnight is the expected day.
- The ParcelShop or locker the parcel was left at is the pickup point. The reply also gives the
  sender, the recipient's name and address, the parcel's dimensions and the delivery's
  coordinates, which are not kept.

## Limitations

- An expired parcel cannot be told from a wrong postcode. GLS drops a parcel some months after
  its delivery.
- Scans in Finland or the Baltic states are read on Amsterdam's clock too.
- No signature or proof of delivery.

## Numbers

The tracking page takes the 14-digit parcel number or the 8-character track ID GLS Netherlands
prints, of letters and digits. A parcel from abroad also has its 12-digit GLS number: its
14-digit form starts with `00` and ends in another check digit, which the adapter does not
compute, so both are taken as typed. The 11-digit GLS number without its check digit is taken
too.

Detection offers GLS Netherlands for 14 digits, which DPD and others share; for 12 digits only
when GLS's check digit passes; and for 8 letters and digits with at least one letter, since GLS
prints some track IDs without a digit. GLS Netherlands issues track IDs starting with `00`, as
GLS France does, so GLS France's rule for them is low and preferred, and its recognition confirms its own parcels. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

gls-info.nl's tracking page and its `ttlink` take the number as `parcelNo` or `NDOC`. Archived
links carry the postcode as `zipCode`; only the number is read from them.

## Testing

`npm run test:carriers:live -- carriers/gls-nl`, with `GLS_NL_POSTCODE` and
`GLS_NL_TRACKING_NUMBER` or `GLS_NL_UNKNOWN_NUMBER` set outside the repository.
