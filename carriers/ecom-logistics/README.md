# Ecom Logistics

Ecom Logistics parcels use enabled universal providers. There is no dedicated adapter.

Ecom Logistics (ShipEcom, formerly EcomLogistics.ca) delivers e-commerce parcels the same or next
day with its own fleet from Toronto, Montreal, Vancouver and Philadelphia. Its site is shipecom.com.

## Numbers

An archived lookup on its own tracking page shows a parcel under E, two digits, a letter and seven
digits. One sample from one source gives a low rule.

## Why there is no adapter

Its tracking page answers `GET shipecom.com/track/{number}` with HTML, without a session or
CAPTCHA: the parcel's history, or a 404 page saying it could not find the number. The adapter is
not written yet.

## Links

The tracking page opens the number from its path, in English, French or Spanish.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
