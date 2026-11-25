# ECL Express Courier Link

Tracks shipments of ECL Express Courier Link, also written Xpress Courier Link, on its own tracking
page. ECL is a courier founded in Karachi in 1992, with offices in Lahore and Islamabad, that
carries documents and parcels within Pakistan and abroad. Its site is xpresscourierlink.com.

## How it works

1. `direct`: `GET https://xpresscourierlink.com/tracking/?txtstatus=International&search={number}`,
   the page the tracking form opens for its default, international service. It needs no cookie,
   key or CAPTCHA.
2. `retry`: the same read once more when ECL cannot be reached.
3. `domestic`: the same page with `txtstatus=Domestic`, only when the international service
   answers that it has no shipment under the number, with one more try when ECL cannot be reached.

- The page is rendered on ECL's server. Its form repeats the service and the number; a shipment's
  card gives the number, the route, the booking date, the current status, and a timeline of scans
  newest first under day headings, each with a clock, a wording and a place. The adapter keeps a
  page only when its form repeats the number and service asked and its card the number.
- "No shipment found" from both services is not found. A bot check or a 401 or 403 is a block, a
  503 maintenance, a redirect or a missing page a moved tracker, and any other page a changed one.
  Every page carries a hidden "imunify-bot-check" trap link, which is not a check.
- The international service is asked first because it is the form's default and the service the
  public sample answers under; the domestic service answers that sample with the same scans.

## Numbers

ECL publishes no layout. The public sample is seven digits, a length many carriers share, so no
rule offers ECL. The adapter takes 5 to 30 letters and digits.

## Notes

- Scans are staged by their whole wording. Clocks are wall clocks without an offset, kept local;
  scans abroad may be in Pakistan's time or the place's.
- The card names the shipper and the consignee; neither is read. The destination's country is read
  from the route. The booking date is not read: on the sample it is later than every scan.

## Links

Tracking links carry the number as `search` on the tracking page, with `txtstatus` naming the
international or domestic service. The tracking address opens international shipments, the form's
default.

## Testing

```sh
npm run test:carriers:live -- carriers/xpress-courier-link
```

`XPRESS_COURIER_LINK_TRACKING_NUMBER` and `XPRESS_COURIER_LINK_UNKNOWN_NUMBER` replace the sample and
the invented number.
