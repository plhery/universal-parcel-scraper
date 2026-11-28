# TOPEST

TOPEST (韬博供应链) is a Shenzhen forwarder that flies parcels abroad and hands them to a post
that delivers, PostNL's cross-border service on the sample. The adapter reads the tracker behind
the tracking page on TOPEST's site.

## How it works

1. `direct`: one `POST https://www.topestexpress.com/price/track/` with the form field
   `TrackingNo`, as the page at `https://www.topestexpress.com/track` sends it. It needs no
   cookie, session, CAPTCHA or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The tracker answers JSON. Code `0` gives TOPEST's waybill in `TrackNumber`, the delivering
  post's number in `TrackingNo` and the rows; the number asked must be one of the two. Code `1`
  with `暂无轨迹信息` and no rows is a number the tracker holds nothing under, read as not found.
  Another code, a page instead of JSON or a row the parser cannot read is a schema failure; HTTP
  401/403 or a bot check is a challenge.
- The page joins several numbers with commas, but the tracker then answers none, so the adapter
  asks one number at a time.

## Notes

- Rows come newest first with their wording and a place that is usually empty. The rows the
  tracker copies from the delivering post are mixed in without a mark.
- Times are wall clocks with no zone and stay `local_time`: TOPEST's rows on China's clock, the
  post's on its own. A row at midnight is a day without a time and keeps only its date.
- `TrackingNo` becomes `delivery_tracking_number`, with `delivery_carrier`, when it is not the
  waybill and another carrier's rules claim the whole number at high confidence; the sample's
  `LX…NL` number reads as Spring GDS, PostNL's cross-border service.
- The summary's `Status`, `ChannelCode` and `Country` are not read. The sample's `Country` is `US`
  on a channel named `EU-NOIOSS`, so the field is no reliable destination.

## Numbers

TOPEST's waybills on the sample are `SZTB`, nine digits and `YQ`; the tracker also answers the
delivering post's number. No detection rule claims the shape, so select TOPEST explicitly. The
sample and its source are in [`numbers.json`](numbers.json).

## Limitations

- No delivery estimate, weight, service, recipient or proof of delivery.
- The site's CDN answers with its own certificate instead of TOPEST's, and HTTP 418 over plain
  HTTP, and the server behind it has no tracker, so every lookup fails to reach TOPEST. The live
  test reports the adapter unverified while the site stays down.

## Testing

`TOPEST_TRACKING_NUMBER=… TOPEST_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/topest`
