# CallCourier

CallCourier parcels use enabled universal providers. There is no dedicated adapter.

CallCourier is a Pakistani courier that delivers cash-on-delivery parcels for online shops
between its city branches.

## Numbers

The tracking page asks for the consignment number. Archived lookups on it show fourteen digits
starting with 10. Fourteen digits are a shape many carriers share, so no rule claims it.

## Why there is no adapter

The tracking page is rendered on the server: the consignment number, shipper, consignee, origin
and destination, then rows of day, status and branch code (RWP, LHE, KHI). It drops older
consignments, and no current one is public, so no reply has shown a live history.
`GET https://cod.callcourier.com.pk/api/CallCourier/GetTackingHistory?cn={number}`, which a
public plugin uses, answers without a key with JSON rows (`TransactionDate`,
`ProcessDescForPortal`, `HomeBranch`, `DestBranch`, `ReasonDesc`) that also carry the
consignee's fields. It keeps only the booking row of older consignments, and answers an unknown
number with `{"error":true,"message":"An error occurred while sending the request."}`, the same
reply as a failure, so a miss proves nothing.

## Links

The tracking page reads the consignment number from `tc` on `callcourier.com.pk/tracking/`, so
`callcourier.com.pk/tracking/?tc={number}` opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
