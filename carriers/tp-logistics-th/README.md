# TP Logistics

TP Logistics, the company behind Thaiparcels, collects and delivers parcels through its own
branches across Thailand. The adapter looks up one document number on its public tracker,
tptrack.info, over plain HTTP.

## How it works

1. `direct`: `GET https://tptrack.info/ecom/dtrack.php?id={number}&type=a1`, the search page,
   then `GET https://tptrack.info/ecom/tdetail.php?fn=a1&code={number}`, the history page its
   button opens. Neither needs a cookie, form post or browser. The search page lists the goods
   with their quantity, destination district and a summary status, beside a button that names
   the number. The history page shows the sender and recipient, the goods, the movements, the
   reasons for any hold and, once delivered, the signature and photos.
2. `retry`: the same reads once more after a failed connection or a timeout. The first attempt
   gets half of the budget. An HTTP status is never sent again.

## Notes

- The search page is read only when its history button names the number asked. The history page
  never prints the number in its text: it is read when its delivery photos are filed under the
  number or, before a delivery, when its goods and quantities are those the search page listed.
  A photo filed under another number, or a page tied by neither, is inconclusive.
- A number the tracker holds nothing for gets the search page without its table, with a script
  that loads a "Not found this Code" box: that is not found, and the history page is not asked.
  A listed number whose history page comes back with the menu bar alone is inconclusive. A
  Cloudflare check or an HTTP 403 is a block, and a redirect, a missing page or a page without
  the tracker's boxes is a changed page; none of them is not found.
- Scans are listed newest first on the branches' wall clocks, day first, and kept as
  `local_time`. Scans carry seconds and no row sits at a fixed hour, so a scan at midnight keeps
  its clock. A Buddhist Era year is read as its Common Era year. A clock that does not parse
  stays as text.
- A hold reason has the minute of the hold it explains and is listed just above it, with its
  number as printed.
- The stage is the search page's summary status when TP Logistics' wordings read it, else the
  newest scan with a stage, else the shared wording rules' reading of the summary. Archived
  history pages printed a code in brackets before each wording; it is kept as the event's code.
- The province of each scan is its location. The sender and recipient names and the recipient
  address are kept. Branch IDs, the destination district, the goods and quantities, the sender
  address, the merchant reference, the signature and the photos are not.

## Limitations

- Only document numbers are looked up. The tracker's second box (`type=tk`) takes merchants'
  e-commerce references, which are not read.
- No estimate, weight, service or instant.
- The tracker drops old documents: they read as not found.

## Numbers

Document numbers have fifteen characters: the origin branch's three letters and two digits, the
date as year, month and day, and a four-digit counter. `tp-logistics-th-1` claims that layout
with low confidence, because three letters and twelve digits are a shape other carriers print
too. The rule leaves out the letter prefixes that other carriers' rules already claim. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker's search box opens `tptrack.info/ecom/dtrack.php?id={number}&type=a1`, and its
history button opens `tptrack.info/ecom/tdetail.php?fn=a1&code={number}`; both are read. With
`type=tk` or `fn=tk` the same pages look up an e-commerce reference, and those links are not
read.

## Testing

`TP_LOGISTICS_TH_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/tp-logistics-th`, with
the number set outside the repository. `TP_LOGISTICS_TH_UNKNOWN_NUMBER` adds a check of a made-up
number.
