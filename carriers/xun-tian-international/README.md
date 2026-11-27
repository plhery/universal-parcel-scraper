# Xun Tian International

Xun Tian International (迅田国际, run by 广东阿信物流有限公司) ships parcels from its gateway in
Guangzhou to Japan, where a local carrier delivers them. Tracked through the guest lookup of its
tenant `xtl` on the ITDIDA platform.

## How it works

1. `direct`: one `GET https://xtl.itdida.com/itdida-api/queryTracks?no={number}`, the lookup
   behind the tenant's tracking page. It needs no cookie, token or browser.
2. `retry`: one more request when the first fails to reach the site or hangs.

The request, the not-found answer (`单号不存在`), the "too busy" rate limit and the reply's checks
are the platform's, in [`itdida.ts`](../whwdt/itdida.ts). The lookup takes waybills, references
and onward numbers alike, so the adapter accepts 6 to 40 letters and digits.

## Notes

- The tenant's landing page links its tracking to a portal on `www.uniment.net`, which puts a
  slider check in front of every visitor. The tenant's own host answers the lookup without one.
- The rows run from the pre-advice through the gateway in Guangzhou, Japanese customs and the
  depot in Japan to the signature. Their wordings are in [`statuses.json`](statuses.json). The
  delivering carrier's bare status updates have no stage, so the parcel keeps the one it had;
  the courier's scan before the hand-off is not read as out for delivery, as the delivery can
  come a day later.
- Rows carry a wall clock with the zone field blank, so they keep `local_time` and a consumer
  dates them. A row whose place names its country, as `GUANGZHOU GATEWAY / CHINA` or
  `KASHIWA / JAPAN`, takes that place's clock. A row without a place takes the clock of the leg
  it sits on: Japan's once a row says the parcel reached its destination or Japanese import
  customs, China's before. Beijing's clock is the fallback for a row with neither, as the
  catalog lists only China among the countries Xun Tian works in. This keeps the customs release
  in Japan before the arrival at the Japanese depot, which Beijing's clock would put after it.
- The reply names neither the delivering carrier nor a number for it, so there is no hand-off.

## Limitations

- No delivery estimate or weight.

## Numbers

The public sample is twelve digits, a shape many carriers share, Japanese carriers among them, so
no rule claims it and the adapter answers explicit selection. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`XUN_TIAN_INTERNATIONAL_TRACKING_NUMBER=… XUN_TIAN_INTERNATIONAL_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/xun-tian-international`
