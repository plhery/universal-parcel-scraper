# HCRD

Tracks shipments of HCRD (惠程荣达, 许昌市惠程荣达货运代理有限公司), a Xuchang forwarder whose
site is xchcrd.com and whose lines carry parcels to the United States, on its own tenant of the
Hualei (华磊) forwarder platform. The client is shared with [GZYL](../gzyl/README.md), whose README
describes the platform; this carrier keeps its host, its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.xchcrd.com:8082`, which the site's tracking link opens, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to the tracking page `trackIndex.htm`,
   which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The rows from the pickup in China to the last US facility come from the platform's custom
  track product (`CO_C_CR`). As on every tenant, they are named as written ahead and listed as
  planned steps, not kept as scans. [status.ts](status.ts) still maps them.
- On the GOFO lines the forwarder writes `in transit via GOFO tracking number:<number>` when
  GOFO takes the parcel, and GOFO's scans follow. That row hands the parcel to GOFO with its
  number, and the support line GOFO appends to its scans is dropped.
- The tracker lists each GOFO scan twice: under the town and state on Beijing's clock, and under
  the bare station name on the station's wall clock. A bare-name row is dropped when a row with
  the same wording reads its wall clock in its state's zone; one without such a twin is kept, and
  dated in the station's zone when GOFO names that station. Other rows, a country or `US` as
  their place, are on Beijing's clock.
- On the FedEx lines a row reads only `FedEx`, without a movement or a number. The map leaves it
  without a stage on purpose.
- The record's product name is the service name and its destination the destination country.

## Limitations

The FedEx lines name neither FedEx's number nor its scans. No delivery estimate or weight.

## Numbers

The samples come from a tracking directory's HCRD page. No detection rule claims HCRD's layout
yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP, no
portal link is published, and the canary checks 17TRACK instead.

## Testing

`HCRD_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/hcrd`, with the number set outside
the repository. The unknown-number case asks for an invented number, or `HCRD_UNKNOWN_NUMBER` when
set.
