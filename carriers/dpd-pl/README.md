# DPD Poland

DPD Poland's public parcel history, for its thirteen-digit waybills ending in a
letter and for fourteen-digit DPD parcel numbers. Switzerland, Germany, France
and the United Kingdom have separate carrier ids.

## How it works

1. `direct`: a GET of `https://tracktrace.dpd.com.pl/EN/findParcel` opens an
   anonymous English session (`JSESSIONID`, with Cloudflare's `__cf_bm`) and
   checks the search form. A POST of the number to `/EN/findPackage` with
   `typ=1`, a parcel number search, returns the parcel block the page shows.
   No account, postcode or CAPTCHA is needed, and each lookup opens its own
   session.

## Notes

- Thirteen digits and a letter is DPD Poland's own waybill, so detection
  selects it. Fourteen digits is shared with other DPD networks and carriers;
  detection suggests DPD Poland first for numbers starting with 13, the range
  its archived tracking pages show most.
- A number typed with the label's check character is looked up by its
  fourteen digits, as in [dpd](../dpd/README.md). Detection suggests DPD
  Poland first for that form too when the digits start with 13 and the
  character matches.
- Tracking links are `parcelDetails` pages on `tracktrace.dpd.com.pl` or
  `tt.dpd.com.pl`, with the number in `p1`. Archived links that name another
  search type in `typ` carry parcel numbers too, so `typ` is not read.
- The reply must name the requested package in its hidden package field, its
  Package field and its package list. A parcel of several packages lists them
  all, each with its own history.
- The session keeps the English page, whose wording is mapped whole in
  [status.ts](status.ts). Changed columns or another language are a schema
  error.
- Mail, SMS and sent notifications are messages to the recipient: they keep
  the stage of the scan before them and never decide the status. The
  `statusMap` lists them as intentional gaps.
- A courier's collection accepts the parcel, unless an earlier scan already
  moved it, as at the pickup point where the sender dropped it off or in
  another DPD country; it is then a hand-over in transit. Its wording alone
  does not give its stage, so the `statusMap` answers unknown for it.
- A return travels under a new parcel number. The original parcel's history
  ends in an exception, and the return's number is not kept.
- A description keeps the scan's first line only, without the recipient's
  name, the pickup point or the links after it. A row without wording, or
  whose first line reads as an email or markup, is left out.
- Rows have a date and a time without an offset. A row scanned by a Polish
  depot or pickup point is read in Polish time. Registration, collections
  without a depot and other countries' scans keep their local clock, and
  `delivered_at` needs a delivery row in Polish time.
- Only the page's no-trace answer naming the requested number, in English or
  in Polish, makes a parcel unknown. One naming another number is a schema
  error; any other reply, a redirect or a 404 is inconclusive.
- Recognition asks the tracker and knows a number when it returns history.

## Limitations

Reference, dispatch code and order number searches are not supported. Depot
codes are not places, so events carry no location. The recipient, the pickup
point and the parcel's other packages are not read, and the page shows no
estimate, sender or weight. After "Sent outside Poland" the history continues
on the destination country's DPD tracker, which is not asked. Polish wording
is not mapped.

## Testing

```sh
DPD_PL_TRACKING_NUMBER=... DPD_PL_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dpd-pl
```
