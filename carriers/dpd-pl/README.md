# DPD Poland

DPD Poland's public parcel history, for its thirteen-digit waybills ending in a
letter and for fourteen-digit DPD parcel numbers. Switzerland, Germany, France
and the United Kingdom have separate carrier ids.

## How it works

1. `direct`: a GET of `https://tracktrace.dpd.com.pl/EN/findParcel` opens an
   anonymous English session (`JSESSIONID`, with Cloudflare's `__cf_bm`) and
   checks the search form. A POST of the number to `/EN/findPackage` with
   `typ=1`, a parcel number search, returns the parcel block the page shows.
   A lookup whose `language` is Polish opens a Polish session at `/findParcel`
   and posts to `/findPackage`. No account, postcode or CAPTCHA is needed, and
   each lookup opens its own session.
2. `group`: a waybill the tracker has no trace of is asked of DPD's group-wide
   guest service, through Belgium's unit as for [DPD Ireland](../dpd-ie/README.md).
   The service holds some waybills the tracker, and its own links, say nothing
   of, and names the waybill whole as the parcel. Fourteen-digit parcel numbers
   are not asked there.

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
- The session keeps its language, English or Polish, and both pages give the
  same dates, times, depots and order of scans. A lookup whose `language` is
  Polish asks for Polish, any other for English; recognition reads English.
  The English wording is mapped whole in [status.ts](status.ts), and each
  Polish wording by the English the page gives the same scan. The Polish page
  tells a scan abroad apart where the English one words it as at home. A
  Polish page with a wording the map has no English for is asked for again in
  English, and stands if that fails. A scan stored in one language takes the
  other's wording in place: at its instant, a wording that translates the
  stored one identifies it. Changed columns, or a heading and columns in
  different languages, are a schema error.
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
  in Polish, makes a parcel unknown, and for a waybill the guest service's
  not-found as well: its other failures leave the lookup inconclusive. A page
  naming another number is a schema error; any other reply, a redirect or a
  404 is inconclusive.
- The guest service gives each milestone once, at its newest date and without
  a place, so its answer is a truncated history. DPD Poland's map reads its
  codes as DPD's map does, with the same milestones left unmapped on purpose.
- Recognition asks DPD Poland's tracker alone and knows a number when it
  returns history.

## Limitations

Reference, dispatch code and order number searches are not supported. Depot
codes are not places, so events carry no location. The recipient, the pickup
point and the parcel's other packages are not read, and the page shows no
estimate, sender or weight. After "Sent outside Poland" the page goes on
with the destination network's scans up to delivery; the destination
country's own DPD tracker is not asked.

## Testing

```sh
DPD_PL_TRACKING_NUMBER=... DPD_PL_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dpd-pl
```
