# AAE

AAE (American Asia Express, AAE全球专递) carries express shipments from its branches in the United States, such as
Los Angeles and New York, to China. Its Chinese site, cn.aaeweb.com, now carries the name of 360 Zebra
(斑马物联网), but 360 Zebra's own tracker does not hold AAE's waybills, so AAE keeps its own carrier.

## How it works

1. `direct`: a GET of `/searchwaybill` on `cn.aaeweb.com` opens an anonymous ASP.NET session: its anti-forgery
   cookie and the token in the page's form. The page's script then posts the number to
   `/SearchWaybill?handler=Tracking&trackingNumber=<number>` with an empty body, the cookie, and the token in an
   `XSRF-TOKEN` header. No account, captcha or browser.
2. `retry`: the same lookup once more, in a new session, when the first fails to reach the site or hangs.

The site answers plain HTTP only. The handler answers a missing or stale token with HTTP 400, read as
indeterminate.

The reply is one block per number: a progress bar, then the rows newest first, each a time and a Chinese wording
opened by the bracketed branch that wrote it. A found waybill's block does not repeat the number, so the adapter
asks one number at a time and refuses a reply with more than one block. An unknown number gets a block naming it
with the sentence `没有找到这个跟踪号的结果`, read as not found only when it names the number asked.

## Notes

- The rows keep their wall clock; the reply gives no zone, and its branches sit on both sides of the Pacific.
- The bracketed branch is the row's location.
- The wordings are staged by `statuses.json`, whose `{station}` stands for a branch, a hub or a city's code;
  others fall to the shared wording rules. The progress bar is not read.

## Limitations

No delivery estimate, weight, recipient or the courier that delivers in China.

## Numbers

Kuaidi100's carrier list describes AAE's China waybills as nine or ten digits, often starting with 10 or 86, a
shape many carriers share, so there is no detection rule and no recognition: a lookup asks AAE only when the user
picks it.

## Links

The tracker is plain HTTP, so no portal link is published; `searchwaybill?danhao=<number>` links on
`cn.aaeweb.com` are read. The canary checks Kuaidi100's page for the firm.

## Testing

`npm run test:carriers:live -- carriers/aae` reads the public sample, or `AAE_TRACKING_NUMBER`.
