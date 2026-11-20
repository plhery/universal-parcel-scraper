# Nhat Tin Logistics

Nhat Tin Logistics is a Vietnamese domestic express carrier. Tracked through the lookup its
tracking page makes.

## Numbers

The developer documentation's examples use CP followed by eight digits, and its webhook example
adds a final R. The low-confidence rule suggests Nhat Tin Logistics for that layout. With a
final 0 the shape also fits DHL eCommerce Spain's generic two-letter rule. Bills posted publicly
also carry CP and nine or eleven digits, which La Poste's and GLS Italy's rules take, and ten
digits alone, which many carriers share. Detection does not offer Nhat Tin Logistics for those,
and there is no recognition. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`ntlogistics.vn/tra-van-don.html?bill={number}` is the address the tracking page's own share
link builds.

## How it works

1. `direct`: one `GET https://bwsv3.ntlogistics.vn/v1/website/search-from-es?q={number}`, as the
   tracking page sends it after its reCAPTCHA, which the service never checks. Its
   `Authorization` header is the page's key: the MD5 of a constant in the page's script followed
   by the day in Vietnam as `DD-MM-YYYY`. The service takes only its own day's key. Within ten
   minutes of midnight in Vietnam, a refused key is followed by one request with the other
   day's key.

- The number goes in capitals: the service fails on lower case. It matches the whole bill, and
  the reply's entry must name the number asked.
- `found: false` is a missing bill. A known bill without scans is listed without history.
- A refused key or another HTTP 401 or 403 is a denied lookup, and a browser check in place of
  the JSON is a challenge. The service's own failure, `success: false`, is inconclusive. A
  redirect or a 404 is a moved route.
- That service only answers from Vietnam; the host supplies a routed fetcher. Elsewhere the
  connection times out, while the website around it loads. The adapter does not own proxy
  credentials.

## Notes

- The bill's status code and wording give its stage; a code that is not mapped falls back to its
  wording, then to the newest scan. A return on its way is an exception; "Đã chuyển hoàn", the
  completed return, is the return.
- Scans are wall clocks to the minute, with no zone, and stay in `local_time`. The place is the
  scan's district and city.
- The expected date's day is kept while the bill is on its way.
- The reply holds the sender's and receiver's names, phones, addresses and districts, the
  contents and the payment; none are read. The history names the sender at pickup and the
  receiver at delivery: those names read `***`, as the page masks them, as does whatever follows
  the dispatch to the receiver, and phone numbers.

## Limitations

- The delay reasons the page shows are not read.
- The Nhat Tin Android app (`vn.ntlogistics.app.user`) is a shipper app on the same network, and
  the developer API there needs a partner's access token.

## Testing

Set private `NHAT_TIN_TRACKING_NUMBER` and `NHAT_TIN_PROXY_URL`, then run
`npm run test:carriers:live -- carriers/nhat-tin/adapter.live.test.ts`.
