# In Time Croatia

In Time is a national parcel courier in Croatia, with its own depots and regional centres, and the
FedEx Express licensee there. Shipments in the FedEx network keep their FedEx numbers. Its site is
in-time.hr. It is a different company from In Time Bulgaria. TrackShip lists it as Intime Express.

## How it works

`direct` asks the API behind the tracking page, `www.in-time.hr/api/track.php?id=<number>`, as the
page's script does: no session, key or browser. The reply is the shipment's route and its rows,
oldest first. It does not repeat the number; the API matches the whole number, case aside, and does
not find the digits without `HR`.

A number the API does not hold is HTTP 404 with `{"error":"Tracking number not found"}`. Any other
error, or that error on another status, is no answer about the number.

Each row has a status code, a label in Croatian with the English wording in parentheses, a time
without a zone and the depot's town. The rows keep their wall clock on Croatia's time. The English
wording is the description, as the English page shows it, and the codes are staged by
`statuses.json`; an unknown code falls to the shared wording rules.

The route names the sender's and recipient's towns, which are not kept; the destination's country
is.

## Numbers

The tracking form gives HR and twelve digits as its example, and the adapter takes that shape only.
No detection rule claims it yet, so a lookup asks In Time when the user picks it.

## Limitations

The reply gives no delivery estimate, signatory or piece count.

## Links

The tracking page opens a number from its `id` parameter.

## Testing

`INTIME_HR_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/intime-hr`
