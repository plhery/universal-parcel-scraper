# ZTCCE

ZTCCE (中途速递, ztcce.com), based in Los Angeles, takes parcels in at warehouses in the US, flies them to China,
clears them through customs and hands them to SF Express. Tracked through the kdfei.cn forwarding platform its
waybill page asks.

## How it works

1. `direct`: one `POST https://api.kdfei.cn/api/getwlbill_web` with the form `param=ao&searchkey={number}`, as
   the page `www.ztcce.com/waybill.html?order={number}` sends it. `ao` is ZTCCE's tenant code on the platform. It
   needs no cookie, token or account.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget.

- HTTP 200 with an empty body is the service's only answer for a number it does not know; the page shows
  查询异常 for it. Only that is not found. A reply whose `state` is not 1 is inconclusive, a waybill whose `pkval`
  is not the number asked is refused, HTML is a browser check or a changed route, and any other status is a moved
  route or a request the service refuses.
- [`kdfei.ts`](kdfei.ts) holds the request, the reader and the adapter for any tenant of the platform. A tenant
  brings its code, its waybill page, the zones of its warehouses and its status map; [`adapter.ts`](adapter.ts)
  is ZTCCE's.

## Notes

- `createtime` is a wall clock with no zone. The rows until the parcel reaches China are on the clock of the
  warehouse `startcity` names, with `place` as the basis: Austin on Central time, Las Vegas and Los Angeles on
  Pacific time. Read on China's clock, their hours would fall in the warehouses' night. A warehouse the adapter
  does not place leaves those rows their wall clock alone. From the first row of arrival in China or of customs
  on, the rows are on China's clock with `destination` as the basis. A clock that would date a row after the
  lookup keeps its wall clock alone.
- The platform's `state` is kept as the scan's code. `statuses.json` records each state with its text.
- `expresscom` and `expressid` name the courier in China and its number. They become the delivery carrier and the
  delivery tracking number when `expresscom` names one courier and that courier's rules offer the number.
- `phone` is never read; it was empty on every reply seen. The text of a row naming a courier, a signer or a phone
  would lose that clause. `endcity`, the recipient's city, is not read.

## Limitations

- No public sample shows the courier's own rows or a parcel from China to the US.
- No delivery estimate, weight, service name, location, sender or recipient.

## Numbers

ZTCCE's waybills seen so far are SYS and nine digits, a shape Purolator's and TNT Australia's rules take for
three letters and nine digits, and T with eight digits, one sample, so detection does not name ZTCCE, and the
adapter answers explicit selection for any number of 6 to 30 letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`www.ztcce.com/waybill.html?order={number}` fills the page's box with the number and asks the service. The search
page is the home page, with its tracking box. The site's server answers some of the page's scripts with HTTP 403
when a browser asks them together, and the page asks nothing without jQuery, so the rendered-link check skips it.

## Testing

`npm run test:carriers:live -- carriers/ztcce` tracks the public sample, or the number in `ZTCCE_TRACKING_NUMBER`,
and checks an invented waybill, or the one in `ZTCCE_UNKNOWN_NUMBER`, reads as not found.
