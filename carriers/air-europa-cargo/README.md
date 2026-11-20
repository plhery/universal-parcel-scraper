# Air Europa Cargo

Track an Air Europa Cargo master air waybill starting with `996`. The public
[carrier form](https://www.uxtracking.com/tracking.asp) takes the prefix and
serial in separate fields and posts them to the same page. The SDK accepts the
complete waybill with or without the printed spacing, hyphen or slash. The
browser link opens the form because the page only searches on POST.

The response echoes the air waybill, lists the booked flights and gives a
separate table of dated cargo operations. The adapter requires the echoed
waybill and reads the operations table for history. It preserves airport
codes where a scan names the station and keeps the clocks as the carrier
prints them, without a timezone. A flight booking, manifest or air-waybill
document notice is distinct from delivery of the cargo.

The [Italian Agency for Development Cooperation report](https://www.aics.gov.it/wp-content/uploads/2023/12/Relazione-Finale-Echo-2024.pdf)
publishes waybill `996 / 1314 6151`. The tracker returned its Milan–Madrid–Havana
history on 20 November 2026. The carrier's own form example `996-12345675`
also returned an Ibiza–Palma history with a Delivery scan. The fixtures replay
the carrier's shipment and operations tables and its native not-found response.

Select **Air Europa Cargo** explicitly.
