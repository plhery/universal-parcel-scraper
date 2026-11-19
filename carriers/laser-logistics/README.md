# Laser Logistics

Laser Logistics is The Laser Group's contract logistics, warehousing and retail distribution
business in South Africa, with its own fleet in the main centres. Its site is laserlogistics.co.za.
Tracked through its own tracking page.

It is not DPD Laser (Dawn Wing), the group's courier, which is
[DPD South Africa](../dpd-za/README.md) in the catalog. Laser Logistics has its own waybills and
tracker, so it has its own entry and no Laser alias.

## How it works

1. `direct`: one `GET https://www.laserlogistics.co.za/parcel-tracking/?waybillnumber={number}`,
   the address the page's form opens. It needs no cookie, token or browser.
2. `retry`: one more attempt after a network failure.

- The page dumps the tracking service's reply into an HTML comment: XML with the waybill, its
  scans oldest first with an event code each, and the service's error text. The adapter reads
  that reply. When the comment is gone it reads the tables the page shows, which carry the same
  scans newest first without their codes, and stages them by their wording.
- An unknown waybill gets "Waybill / Parcel with number '…' could not be found." naming the
  number asked; that is not found. Another error text is inconclusive. A 404 or a redirect is a
  moved route, an empty page is inconclusive and a firewall page is a challenge.
- The waybill the reply names must be the one asked. The tracker matches whole waybills only,
  in either case.
- Recognition makes the same request.

## Notes

- Scans give a date and a clock with no zone. Every branch is in South Africa, which keeps
  UTC+2 all year, so each scan is dated on that offset.
- The proof of delivery's scan comes before the driver's confirmation off the delivery sheet,
  which is written hours later; the delivered time is the waybill's own, the proof of delivery's.
- "In Trip" is the load onto the delivery trip at the delivering hub, so it is out for delivery.
- Scans name a branch code, not a place, so they have no location. The suburbs, the pieces, the
  shipper's reference and the receiver field the page hides, which reads "SIGNED", are not kept.

## Numbers

The public example is three letters and eight digits. Only an aggregator's example shows it, so
no rule claims the shape; the adapter answers an explicit selection or a tracking link.

## Links

`www.laserlogistics.co.za/parcel-tracking/?waybillnumber=<number>` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/laser-logistics`, with `LASER_LOGISTICS_TRACKING_NUMBER`
and optionally `LASER_LOGISTICS_UNKNOWN_NUMBER` set outside the repository.
