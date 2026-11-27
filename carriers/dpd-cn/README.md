# DPD China

DPD China is the DPD network's unit in mainland China, run by Lenton Group. It sends e-commerce
parcels from Shenzhen to Europe, where the destination's DPD unit delivers them under the same
number. The adapter reads the tracker on `tracking.dpd.cn`.

## How it works

1. `direct`: one `POST https://apitracking.hub-ez.com/api/services/app/tracking/GetTrackingNew`
   with the JSON body `{"para": "<JSON text>"}`, the text naming the number with `hawbType` `H`,
   as the tracker's script sends it. It needs no cookie, token, CAPTCHA or browser. `hawbType` `C`
   searches shippers' references instead, so the adapter never sends it.
2. `retry`: the request once more when it fails to reach the service or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The service answers an ABP envelope whose `result` is JSON text holding one row per number
  asked, and the row must repeat the number. A row marked `NotFound` without scans is the
  tracker's "No Found", read as not found. `success` false, an `error`, a row for another number
  or several rows for the number are failures; `unAuthorizedRequest`, HTTP 403 or a bot check is
  a challenge; a redirect or a 404 is a moved service.
- The same service and app serve Lenton Group's other trackers, such as
  [DPD Hong Kong](../dpd-hk/README.md) and [RPX Online](../rpx-hk/README.md); the host only picks
  the branding. Recognition therefore reads a number as known only on its scans and as unknown
  only on its `NotFound` row. A row listed without scans fails recognition, since it does not
  show that DPD China holds the parcel.

## Notes

- Scans come newest first, each with its wording, a place and the scanning facility's wall
  clock. China's places are towns (`ShenZhen` is written Shenzhen); the destination unit's are
  country names. The clocks stay `local_time` and are dated by their place, so China's scans fall
  on Shanghai's clock and the destination's on that country's.
- The tracker marks the proof-of-delivery row delivered, and "Signature available" also follows
  the delivery scan. Both are kept without a stage, so a delivery is not read twice.
- Notices to the recipient and the recipient's redirection requests, to a safe place or a pickup
  point, keep the stage of the scan before them. A redirection can be dated before the parcel
  leaves China.
- A scan the map lacks takes the tracker's delivered mark, then the shared wording rules. When no
  scan has a stage, the row's `Status` gives it.
- The destination comes from the row's `FromTo`. The rows already carry the delivering unit's
  scans, so there is no delivery hand-off: SEUR delivers in Spain, BRT in Italy, DPD or Chronopost
  in France, and the national DPD unit elsewhere. The replies name the country, not the unit.
- `CustomerRef`, the shipper's reference, the piece count and the scans' links are not kept.

## Numbers

DPD parcel numbers are fourteen digits that begin with the sending depot; DPD China's parcels
begin `8415`. A low preferred rule lists DPD China first among the fourteen-digit candidates
without selecting it, and recognition asks the tracker. The synthetic shape check is in
[`numbers.json`](numbers.json).

## Links

`tracking.dpd.cn/?trackNo=<number>` opens the tracker and searches; its script also reads
`trackingNumber`.

## Limitations

- No delivery estimate, weight, service or recipient.
- A destination row filed while the parcel is still in China, such as an early redirection, names
  only a country. When that country has several clocks, as Spain and France do, it takes the
  clock of the China scans beside it.

## Testing

`DPD_CN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/dpd-cn`
