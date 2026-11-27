# Lingdong International

Tracks shipments of Shenzhen Lingdong International Freight Forwarding (领东国际,
深圳市领东国际货运代理有限公司), a Chinese forwarder whose site is lingdong56.com, on its own
tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `tms.lingdong56.com:8082`, then, when the interface holds no row for the number, one POST
   of the same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The forwarder writes its scans in English: its Shenzhen warehouse's arrival (`ARRIVAL`) and
  departure (`SHIPMENT`) rows, each with a place, then the flight, customs and hand-over rows in
  Chinese and English, and the delivery partner's scans as it relays them, such as Poste
  Italiane's in Italy and GOFO's in the United States. The stage comes from the wording in
  [status.ts](status.ts). A row in Chinese and then the same in English, after a slash or in
  `【】`, shows its English half; the map reads either. The flight booked before it flies ("Expected
  flight on …") and its expected landing once it flies ("It is expected to arrive at the local time on
  the …", after a delay to the schedule or not) are forecasts, notices on the stage of the scan before them. A partner's scan can be listed twice at one clock and place, its
  headline alone ("In transito") and with the partner's sentence after it: when both give one
  stage, only the fuller row is kept. A row of punctuation alone, as the full stop the tracker can
  show after the warehouse's departure, names nothing and keeps the stage of the scan before it.
  On a line UPS delivers, the tracker copies UPS's label row in Chinese and in English, as
  [JRT's](../jrt/README.md) does.
- Scan times are wall clocks without an offset on the platform's Beijing clock, as
  [GZYL's](../gzyl/README.md) are, and are read on it; a row dated after the lookup is held
  back. Poste Italiane's relayed scans are on it too: the platform wrote one hours after its
  Beijing clock, and before the same clock read on Rome's.
- GOFO's scans are not. The tracker copies them in GOFO's English under the town and its state's
  code ("EXAMPLE TOWN,IL"), and GOFO's label ("Shipping Label Created") without a place, on GOFO's
  clocks, as [JRT's](../jrt/README.md) tracker does: a station GOFO dates on its zone takes that
  zone and the label Pacific time ([GOFO](../gofo/README.md)). A row at another US town and state
  keeps its wall clock, which the state dates. Read on Beijing time, an Illinois hub scan came 14
  hours early.

## Limitations

The record names no delivery carrier, so the delivery partner's scans are only those the
forwarder relays. Once the forwarder hands an order on, the delivery carrier's number can take
its tracking number, and the tracker then finds the order by the SZLD number without showing it:
a lone order it finds that way answers the number, and the number it shows is passed on as the
delivery tracking number.

## Numbers

Lingdong International's waybills are SZLD and ten digits. The prefix is the forwarder's
Shenzhen and Lingdong initials and no other carrier issues the layout, so the rule has high
confidence. No public number has been found, so the corpus holds a synthetic one.

## Links

`tms.lingdong56.com:8082/trackIndex.htm?documentCode={number}` opens one parcel on the
forwarder's tracker, which its site links to. Since it is plain HTTP, no portal link is
published.

## Testing

`npm run test:carriers:live -- carriers/lingdong`, with `LINGDONG_TRACKING_NUMBER` and
optionally `LINGDONG_UNKNOWN_NUMBER` set outside the repository.
