# DpdEx

DpdEx (多普达国际, Shenzhen Duopuda Smart Logistics) is a Shenzhen forwarder with air parcel lines
from China to Europe for cross-border e-commerce, where local carriers such as Evri and iMile
deliver the parcels. Its site is duopudaexpress.com. It is not part of DPD. Tracked through its
tenant of the rtb56 tracking platform.

## How it works

1. `direct`: one `GET https://client.duopudaexpress.com/webservice/Service.ashx` with
   `method=track` and the number, signed as the platform's pages sign it. It needs no cookie,
   token, account, CAPTCHA or browser. [`../yypost/rtb56.ts`](../yypost/rtb56.ts) builds the
   request and reads the reply.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number with no waybill is HTTP 200 with `"success":0` and "No query to track information",
  which is not found. Any other message is inconclusive, and a 404 or a redirect is a moved route.
- Only the entry whose `server_hawbcode` is the whole number asked is read; the merchant's
  reference never is.
- The tracking page, `track_query.aspx`, ignores a number in its address, so the catalog's link
  opens its empty search form. That search can ask for a slider CAPTCHA; the lookup beside it
  does not.

## Notes

- Scans are wall clocks without an offset, so they keep `local_time` and the result keeps the
  tracker's order. The export, airport and flight rows are filed in batches, a few hours apart
  to the second.
- DpdEx's own scans carry a code, mapped in [`statuses.json`](statuses.json); the delivering
  carrier's come in English without one and go through the shared wording rules unless the map
  names them.
- `channel_hawbcode` is the delivering carrier's number, kept as the onward number. The
  merchant's reference and whoever signed are not kept.

## Limitations

- No delivery estimate or weight.
- The delivering carrier is not named apart from its wording, so the onward number comes
  without a carrier.

## Numbers

Waybills are `DPE` and eleven digits. The public sample and a parcel the app tracked, which
ParcelsApp named DpdEx and iMile delivered in Italy, both have that layout. With one public
number, the rule offering DpdEx for it stays low confidence. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`DPDEX_TRACKING_NUMBER=… DPDEX_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/dpdex`
