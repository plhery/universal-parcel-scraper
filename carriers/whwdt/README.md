# Wuhan Wodetong

Wuhan Wodetong (武汉沃德通, WHWDT) forwards e-commerce parcels from its warehouse in Shenzhen to
other countries, where local carriers such as USPS deliver them. Tracked through the guest lookup
of its portal on the ITDIDA platform.

## How it works

1. `direct`: one `GET https://hyd.itdida.com/itdida-api/queryTracks?no={number}`, the lookup
   behind the order search the forwarder's site links to. It needs no cookie, token, key or
   browser. The JSON reply holds one entry per number, with the waybill's summary in `detail`
   and its scans newest first in `trackList`.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number the tenant holds no waybill under is HTTP 200 with an entry whose `errorMsg` is
  `单号不存在`, "the number does not exist", which is not found. Any other message is
  inconclusive, and a 404 or a redirect is a moved route.
- A lookup sent within a second or so of another gets HTTP 503 with `"data":"too busy"`, which
  is a rate limit. A 503 without it is maintenance.
- The entry's `no` must be the number asked.
- The request and reply are the same on every ITDIDA tenant, so [`itdida.ts`](itdida.ts) holds
  the lookup, the reply's checks and the scans for any of them; each tenant gives its host, its
  numbers and its status map.

## Notes

- The scans come from the warehouse in Shenzhen, the airport in Hong Kong, the destination's
  customs and the delivering carrier. Each is a wall clock in its own place, with the zone field
  blank, so scans keep `local_time` and the result keeps the tracker's order. A scan that states
  an offset in the zone field would get its instant.
- Places drop postcodes, as the delivering carrier's scans name the recipient's town by them.
  A delivery's wording drops whoever signed for it.
- The forwarder's own Chinese wordings are in [`statuses.json`](statuses.json); the delivering
  carrier's English scans go through the shared wording rules.
- The waybill names the destination country in Chinese, as `美国`, read as an ISO code, and the
  onward carrier's number as `zhuanDanHao` once it has one. The customer reference is not kept.

## Limitations

- No delivery estimate or weight.
- The onward carrier's name is free text, so the result gives its number without naming it.

## Numbers

The only public waybill is the example the forwarder's home page prints: a letter, twelve digits
and a letter. One sample is too few to tell its series from other carriers' numbers, so no rule
claims it and the adapter answers explicit selection. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`WHWDT_TRACKING_NUMBER=… WHWDT_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/whwdt`
