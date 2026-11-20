# SheenSync

SheenSync (鲜行供应链) forwards e-commerce parcels from Hangzhou to other
countries, where partners deliver them. Tracked through the lookup behind its tracking page.

## How it works

1. `direct`: one `GET https://sheen-sync.com/api/track?nums={number}`, the call the tracking
   page makes. It needs no cookie, token, key or browser. The reply has the rtb56 platform's
   shape, as plain JSON rather than JSONP, so [`../yypost/rtb56.ts`](../yypost/rtb56.ts) reads it.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number with no waybill is HTTP 200 with `"success":0` and "No query to track information",
  which is not found. Any other message is inconclusive, and a 404 or a redirect is a moved route.
- Only the entry whose `server_hawbcode` is the whole number asked is read. The page would also
  match the merchant's reference or the line's number, which the adapter never accepts as the
  waybill.
- The tracking page opens a number from its `c` parameter, which the catalog's link uses.

## Notes

- Every scan states `+08:00`, the American ones too, whose clocks follow a delivery day in the
  United States. The offset is the system's, not the scan's place, so scans keep wall clocks and
  the result keeps the tracker's order.
- The forwarder's own scans carry a code (`IR`, `AF`, `DF`, `PBGJ`), mapped in
  [`statuses.json`](statuses.json); the line haul's and the delivering partner's scans come in
  English without one, and go through the shared wording rules unless the map names them.
- `channel_hawbcode` is the line's own number for the parcel, kept as the onward number. The
  merchant's reference and whoever signed are not kept, and the "SYSTEM" place of the label scan
  is dropped.

## Limitations

- No delivery estimate or weight.
- The partner that delivers is not named, so the result gives the onward number without a carrier.

## Numbers

The tracking page checks for SS and twelve digits and gives one example, the only public
waybill. It is too few to claim the shape from other carriers' numbers, so no rule claims it and
the adapter answers explicit selection. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`SHEENSYNC_TRACKING_NUMBER=… SHEENSYNC_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/sheensync`
