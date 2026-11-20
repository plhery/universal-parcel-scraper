# YITU

YITU (义途, Yiwu Yitu Supply Chain) runs dedicated small-parcel lines for online sellers from Yiwu
to Europe, North America and Australia, where local carriers such as DHL and USPS deliver the
parcels. Tracked through its tenant of the rtb56 tracking platform.

## How it works

1. `direct`: one `GET http://ytgyl.rtb56.com/webservice/Service.ashx` with `method=track` and the
   number, signed as the platform's pages sign it. It needs no cookie, token, account or browser.
   [`../yypost/rtb56.ts`](../yypost/rtb56.ts) builds the request and reads the reply.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- The company's site, ytgyl.com, links the tenant's tracking page. Both answer only plain HTTP,
  so the catalog links neither.
- A number with no waybill is HTTP 200 with `"success":0` and "No query to track information",
  which is not found. Any other message, such as "The service is busy", is inconclusive, and a 404
  or a redirect is a moved route.
- Only the entry whose `server_hawbcode` is the whole number asked is read; the merchant's
  reference never is.

## Notes

- Every row states `+08:00`, the delivering carrier's rows at the destination too, so rows keep
  their wall clocks and the result keeps the tracker's order.
- YITU's first scans carry a code (`IR`, `AF`, `DF`); its later ones come in Chinese without one.
  Both are mapped in [`statuses.json`](statuses.json); the delivering carrier's English scans go
  through the shared wording rules.
- `channel_hawbcode` is kept as the onward number once the line gives one. The merchant's
  reference and whoever signed are not kept.

## Limitations

- No delivery estimate or weight.
- The delivering carrier is not named, so an onward number comes without a carrier.

## Numbers

The only public waybill is Y, twelve digits and T. One sample is too few to tell its series from
other carriers' numbers, so no rule claims it and the adapter answers explicit selection. The
sample and its source are in [`numbers.json`](numbers.json).

## Testing

`YITU_TRACKING_NUMBER=… YITU_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/yitu`
