# Golilla

Golilla S.R.L., set up with the Adeo group, Leroy Merlin's parent, delivers and installs bulky goods
such as pallets, stoves, air conditioners, doors, windows and furniture across Italy, including
Leroy Merlin's home deliveries. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://tms.golilla.it/ope/rest/tracking/{number}`, the lookup the tracking
   page on `my.golilla.it` makes for a shipment number. It needs no cookie, token, key or browser.
   The JSON reply has the shipment's summary, its parcels with their scans and its planned
   delivery day.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The tracking page sits behind DataDome, but the lookup's host does not check. SafeLine, the
  firewall in front of it, answers its browser check with HTTP 468; that, DataDome's or any other
  check is a challenge.
- An unknown number is HTTP 404 with the message `Spedizione non trovata`. Any other 404, a 410
  or a redirect is a moved route.
- The reply must give back the whole number asked.

## Notes

- The tracker is the software Liccardi's runs on, with Golilla's own list of event codes.
- Scan times are UTC instants, which the page shows in the visitor's zone. They are returned at
  Italy's offset.
- Each parcel of a shipment has its own scans, which often repeat the others' a second or two
  apart. The history keeps a scan once per branch and code within a minute. The shipment is
  delivered when every parcel is; until then it takes the newest scan of a parcel still on its
  way.
- The `codEsito` stages a scan. The map covers the tracker's own list of event codes
  (`/ope/rest/codiciEsiti`) and follows the page's script, which files them under five progress
  steps, apart from the steps that hide a pickup point, a return, a failed delivery or a booked
  delivery. The page files `SERVIZIO PROGRAMMATO` under registration, but Golilla scans it when a
  delivery appointment is booked at the destination branch, so it is in transit there. A
  cancelled appointment and the other codes that move nothing have no stage. Handing the goods
  to the installer counts as a delivery, as the page counts it.
- The estimate is the delivery day the page shows when the reply has one, else the planned day
  as last updated, else the first planned. A delivered or returned shipment has none. A filled
  `estimatedArrivalTimeStart` or `estimatedArrivalTimeFinish`, a slot on that day which the
  adapter does not read yet, is named in `unread_estimates`.
- The recipient's town, province, postcode and position, the sender and its references, the
  parcels' references, the staff who entered each scan, the proof of delivery and the shipment's
  progress steps are not kept.

## Limitations

- The page also finds a shipment by a parcel's reference or by the sender's reference with its
  customer code. The adapter asks only for the shipment number.
- Links in Golilla's messages open the tracker with a token instead of the number, which the
  library cannot read.

## Numbers

Golilla's shipment numbers are a counter, now seven digits. Recipients quote them in complaints.
Seven and eight digits are shared by many carriers, so there is no detection rule. The adapter
takes seven or eight digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker on `my.golilla.it/segui` reads the number from `?ldv=` and looks it up when the page
opens, so `my.golilla.it/segui?ldv={number}` opens one shipment. The library reads the number
from that address.

## Testing

`npm run test:carriers:live -- carriers/golilla`, with `GOLILLA_TRACKING_NUMBER` and optionally
`GOLILLA_UNKNOWN_NUMBER` set outside the repository.
