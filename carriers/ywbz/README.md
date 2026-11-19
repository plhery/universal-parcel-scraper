# YWBZ Express

YWBZ Express (义乌百洲国际货运代理有限公司, Yiwu Baizhou International Freight Forwarding) is a
Yiwu forwarder running small-parcel lines from China to the United States, Canada and Europe,
handing parcels to local carriers. Its site is ywbzexpress.com. The adapter reads its tracker's
own lookup for numbers of YWBZ and ten digits.

## How it works

1. `direct`: the tracking page the site links to, `http://ywbz.rtb56.com/track_query.aspx`, posts
   its form back to itself, but YWBZ's tenant of the rtb56 platform also answers the platform's
   `GET /webservice/Service.ashx` lookup without a cookie, account or CAPTCHA. The adapter sends
   the same request as [YYpost's](../yypost/README.md), through the module the platform's adapters
   share. The host answers plain HTTP only.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

- Only the entry whose `server_hawbcode` is the whole number asked is read.
- The tracker's unknown-number answer is a not-found. Its "Parameter error" is a schema failure
  and any other refusal is inconclusive. Redirects, 404s and browser checks are never read as a
  missing parcel.
- Recognition makes the same lookup.

## Notes

- A scan's `gmt_offset` follows its place: China's in Yiwu and Xi'an, the destination's at the
  airport it lands at and on the delivering network's scans. A scan with an offset gets its
  instant; one without, as USPS's scans on the older line, keeps its wall clock. The tracker
  orders scans by wall clock, so they are re-ordered by instant only when every scan has one.
- Scans are English wording with few codes and no one scheme to them, so the stage comes from the
  wording: [statuses.json](statuses.json), then the shared rules.
- A delivering network's scan opens with its place, which the scan's place repeats; the wording
  keeps what follows.
- `channel_hawbcode` has been empty. A scan saying the warehouse changed the last-mile vendor
  names the new number, which becomes `delivery_tracking_number`. When that number is SwiftX's or
  Yanwen Express's by their own rules, the result names that network.
- The merchant's order reference, the proof-of-delivery link and the signatory field, which holds
  no name, are not read.

## Limitations

No ETA, weight or service.

## Numbers

ParcelPanel's and CWILL's examples are YWBZ and ten digits, and YWBZ's tracker answers both. The
prefix is the company's own code, so the rule names YWBZ Express with high confidence.

## Links

The tracker is HTTP only, so the catalog opens no carrier page.

## Testing

`npm run test:carriers:live -- carriers/ywbz`, with `YWBZ_TRACKING_NUMBER` and optionally
`YWBZ_UNKNOWN_NUMBER` set outside the repository.
