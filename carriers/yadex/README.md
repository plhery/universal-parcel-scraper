# Yadex

Yadex (源安达, Dongguan Yuananda Express) is a domestic express courier in the Pearl River Delta, with
branches and stations across Guangdong. Its site is yadex.com.cn.

## How it works

1. `direct`: one GET of `/index/waybill/call?nu=<number>` on `yadex.com.cn:9000`, the timeline the
   waybill page asks for and appends. No session, cookie, account or browser.

The site answers plain HTTP only, on port 9000, where www.yadex.com.cn redirects.

The reply is an HTML fragment of timeline rows, newest first, each a time without a zone and a
Chinese wording that names the station in brackets. A number the tracker holds nothing for is one
sentence, `单号<number> 暂无物流记录`, read as not found only when it names the number asked. The
timeline itself does not repeat the number.

## Notes

- The rows keep their wall clock on China's time.
- The tracker writes the station's phone numbers after an arrival and the signer's name in the
  delivery; both are left out, and so are a courier's name and mobile number should a row give them.
- The station a row arrived at, left or was signed for at is its location. The network centre
  (网管中心) is the carrier's hub, named without a town.
- The wordings are staged by `statuses.json`, whose `{station}` stands for the bracketed station;
  others fall to the shared wording rules.

## Limitations

No delivery estimate, sender, recipient or weight.

## Numbers

The public example is twelve digits, a shape many carriers share, so there is no detection rule and
the adapter has no recognition: a lookup asks Yadex only when the user picks it. The adapter takes
ten to fourteen digits.

## Links

The waybill page is plain HTTP on port 9000, so no portal link is published, and the canary checks
17TRACK.

## Testing

`YADEX_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/yadex`
