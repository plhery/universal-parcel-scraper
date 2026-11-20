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

Select **Air Europa Cargo** explicitly. Run the live checks with the published numbers.

```sh
AIR_EUROPA_CARGO_TRACKING_NUMBER="$PUBLIC_NUMBER" AIR_EUROPA_CARGO_UNKNOWN_NUMBER="$PUBLIC_MISS" \
  npm run test:carriers:live -- carriers/air-europa-cargo/adapter.live.test.ts
```
