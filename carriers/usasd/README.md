# SD Group

SD Group (美国顺达集团), run by S & D Logistics Inc, is a New York forwarder shipping parcels and freight from
the United States to China, from warehouses in Flushing and College Point, New York, and in Massachusetts and
New Jersey. It flies parcels to a port of clearance in China and hands them to a Chinese courier. Tracked
through the search of its DsyExpress site, usasd.com, with the reader in
[`carriers/overseaex`](../overseaex/README.md).

## How it works

1. `direct`: one `GET https://www.usasd.com/index.php?c=index&f=search&sn={number}`, as the site's tracking box
   sends it. It needs no cookie, token or account.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget.

- The platform's tips page with 运单信息不存在 is the only not-found; the reader in
  [`dsyexpress.ts`](../overseaex/dsyexpress.ts) says how every other answer reads.
- The reply does not echo the number: the scans are those of the number in the request. No redirect is followed.
- Older waybills have a second lookup, `f=inquirywaybillData`, with the same parameter. It is not asked.

## Notes

- The rows carry no zone. The platform writes its own rows on its server's clock, whose own stamps are UTC+8:
  the New York warehouse's rows come a little after midnight on that clock, around noon in New York. Those rows
  and Yunda's are on China's clock with `carrier` as the basis.
- The line-haul feed's rows that name `【美国 - 纽约】` are on New York's clock, where they fall in working hours,
  with `place` as the basis; those naming `【中国 - …】` are on China's clock. Its rows written as one bracket name
  no place and keep their wall clock alone. A clock that would date a row after the lookup also keeps its wall
  clock alone.
- The header `物流信息(韵达:…)` gives Yunda's number, which becomes the delivery tracking number when Yunda's
  rules offer it.
- Yunda's rows name the courier with a mobile, give branch landlines and hotlines, say where a locker stands and
  end on a courtesy. Those parts are left out.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.

## Numbers

SD Group's waybill on the public sample is `SDL` and ten digits, which detection names with low confidence.
The adapter answers explicit selection for any number of 6 to 30 letters and digits. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

`www.usasd.com/index.php?c=index&f=search&sn={number}` opens the reply for the number, as the home page's search
dialog and the older waybill lookup build it.

## Testing

`npm run test:carriers:live -- carriers/usasd` tracks the public sample, or the number in
`USASD_TRACKING_NUMBER`, and checks an invented waybill, or the one in `USASD_UNKNOWN_NUMBER`, reads as not
found.
