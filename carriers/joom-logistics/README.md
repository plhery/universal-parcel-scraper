# Joom Logistics

Joom Logistics is the Hong Kong logistics arm of the Joom marketplace. It ships parcels from
China, Japan and Korea and tracks them under the numbers of the carriers that carry them,
national posts' S10 numbers, USPS barcodes and Hermes numbers among them. Tracked through the
interface its tracking page asks.

## How it works

1. `direct`: `GET https://api-logistics.joom.com/api/0.1/trackings?trackingNumber=<number>&lang=en`,
   as the page at joomlogistics.com asks it. It needs no account, key, cookie or CAPTCHA.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- The reply holds, under `data`, the number the parcel is filed under and its other numbers, the
  number the delivering carrier tracks it by (`actualTrackingNumber`), the countries, a delivered
  flag and the scans, oldest first. The parcel must be filed under the whole number asked.
- A number it does not know gets HTTP 404 with `api.not_found` and a message naming the number. Only
  that answer is not found. Another 404, a redirect or a page in place of JSON is a moved or changed
  route, HTTP 403 or a browser check is a challenge, and a reply for another number is inconclusive.
- A parcel without scans is no history with the reason `listed`, unless the delivered flag is set.
  The flag also decides the stage when the last scan does not say delivered.

## Times

Every clock is labelled UTC (`Z`), but only Joom Logistics' own scans are UTC. The scans it relays
from flights, lines, posts and couriers carry their local wall clock under the Z.

- Instants: the order and warehouse check-in codes (`informationReceived`, `parcelCheckIn`), and
  `originCountry` and `inTransit` scans whose country is not the destination. The order system
  stamps a warehouse's check-in and its own status change, to the millisecond, 3.7 seconds apart.
  Joom's backend records the marketplace's data one to four minutes after the Hong Kong centre's
  scans.
- Wall clocks, kept as `local_time`: every other scan. USPS delivers at 13:50 and starts its round at
  06:10 under the Z, and its code-less rows match Pitney Bowes' rows in California to the minute.
  SEKO's flight from Hong Kong to Liège takes 12h15 between the two wall clocks, the real flight
  time, against 5h15 read as UTC. Relayed scans before the border name no country.
- Russian Post's scans are kept as wall clocks, though they may be UTC: its own service could not be
  compared, and one collection at 06:00 under the Z would come before a Moscow office opens.

## Notes

- A scan's place is kept with its country code after it, as the page shows them.
- `actualTrackingNumber` becomes `delivery_tracking_number` when it differs from the number asked;
  the page shows it as the actual tracking number. The reply does not name the carrier, so
  `delivery_carrier` is set only when one carrier's high-confidence rule claims that number.
- Some of Joom Logistics' own rows come without a country, or without a code, and keep their wall
  clock. "Data from the trading platform received" moves nothing.

## Numbers

The tracker finds a number only as it was filed: in upper case and, for numbers filed with hyphens,
with them. The adapter takes four to forty letters and digits, at least one a digit. Lookups drop
hyphens, so a reference in the hyphenated layout (two letters and three digits, a date, four digits)
is asked with them restored, then as given. No rule offers Joom Logistics: its numbers are other
carriers' ([`gaps.json`](../../core/detection/gaps.json)). Parcels a universal provider names Joom
Logistics may be unknown to its tracker. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker's `/<language>/track?id=` opens one number, on joomlogistics.com and
logistics.joom.com.

## Testing

`npm run test:carriers:live -- carriers/joom-logistics` looks up a public sample and an invented
number, or `JOOM_LOGISTICS_UNKNOWN_NUMBER`, and `JOOM_LOGISTICS_TRACKING_NUMBER` when set.
