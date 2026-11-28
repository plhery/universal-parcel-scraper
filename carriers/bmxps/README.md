# BMXPS

BMXPS (北美快运, 北美国际物流, bmxps.com), with offices in Shanghai and Halethorpe, Maryland, takes parcels in at
its Baltimore warehouse, flies them to China, clears them through customs and hands them to SF Express. Tracked
through the route its tracking page posts to.

## How it works

1. `direct`: one `POST https://www.bmxps.com/Home/Tracking` with the form `orderNumber={number}`, as the page
   `/Home/OrderTracking?orderNumber={number}` sends it. It needs no cookie, token or account.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget.

- `{"result":false,"message":"订单不存在","data":null}` is the tracker's answer for an order it does not know,
  which is not found. Another refusal is inconclusive. HTML is a browser check or a changed route, and a non-200
  reply is a moved route or a request the site refuses.
- The reply does not repeat the number; the not-found answer for an invented order is distinct, so a list of rows
  is read as the order asked.

## Notes

- `EventTime` is ASP.NET's `/Date(ms)/`, epoch milliseconds, so every row is an instant.
- The text names the Baltimore warehouse or SF Express's branch in brackets, such as 【JF-Baltimore】; the first
  bracket is kept as the location. The hand-off row's bracket names the courier, so it gives no location.
  `statuses.json` records each text with its places as 【…】.
- After customs the tracker relays SF Express's scans. The row 已转【顺丰速递】派送，运单号 … names SF's waybill;
  it becomes the delivery carrier and the delivery tracking number when SF Express's rules offer the number.
- SF's last row, a second after the delivery, points to the signature picture and the signer on SF's site. It is
  no scan and is left out, as is any courier, signer or phone a relayed row names.

## Limitations

- No public sample shows a parcel from China to the US, or a hand-off to a courier other than SF Express.
- No delivery estimate, weight, service name, sender or recipient.

## Numbers

BMXPS's orders seen so far are BM and ten digits, a shape other carriers' rules take, so detection does not name
BMXPS, and the adapter answers explicit selection for any number of 6 to 30 letters and digits. The sample and its
source are in [`numbers.json`](numbers.json).

## Links

`www.bmxps.com/Home/OrderTracking?orderNumber={number}` opens the order on the tracking page.

## Testing

`npm run test:carriers:live -- carriers/bmxps` tracks the public sample, or the number in `BMXPS_TRACKING_NUMBER`,
and checks an invented order, or the one in `BMXPS_UNKNOWN_NUMBER`, reads as not found.
