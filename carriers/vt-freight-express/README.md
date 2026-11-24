# VT Freight Express

VT Freight Express, formerly VicTas Freight Express, carries parcels, skids and pallets between Melbourne,
Tasmania and the eastern states. Freightways owns it. Its site is vtfe.com.au. Tracked through its public
tracker's own page.

## Numbers

Its consignment numbers open with a prefix set per sender, such as four letters and seven digits or three
letters and ten or eleven digits. The prefixes name senders, not the carrier, so there is no rule. The adapter
sends six to thirty letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://portal.vtfe.com.au/Track/VTFE/{number}`, the address the tracker's search box
   builds from its portal code and the number typed. It needs no cookie, token, key or browser. The reply is
   the HTML page of a Transvirtual tracker, the consignment software behind
   [Hunter Express](../hunter-express/README.md)'s tracker too: a heading with the current status, the
   consignment's details, the delivery's details and the history table, oldest first.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets half of the
   budget, so the retry fits in the rest.

- The details must name the whole number asked, and the page must be the VTFE portal's.
- A number the tracker has no consignment for gets its empty search form with "Missing or incorrect tracking
  number", under an id built from the address asked, so the answer counts only when that id repeats the
  number. The archived consignments in `numbers.json` get the same answer once the tracker has dropped them,
  so it is inconclusive (`portal_not_found`), not a missing parcel.
- The page answers every number with HTTP 200, so a 404 or a redirect is a moved route and a 403 a refusal.
- No recognition: the tracker never says a number is unknown, and no rule offers VT Freight Express.

## Clocks

History rows group the scans of one kind at one depot on one day and show only the day. Each grouped row's
detail panel, which the page loads on a click, lists the scans with their clock; the panel's address already
carries the group's scans as UTC ticks, so the first of them is the row's instant and no extra request is
made. In the sample, the delivery's ticks fall within the minute of the clock its delivery row states in AEST.
The ticks are used only when the address names the row's wording, depot, day and consignment and fall on the
row's day in an Australian zone; otherwise the row keeps its day as `local_time`.

The delivery row, and a dated status above the history, show a clock with the zone's abbreviation, such as
`AEST`; the five Australian abbreviations give the offset, and another keeps the wall clock as `local_time`.
No zone is deduced: the consignments cross from Victoria and Tasmania to Queensland, which keeps standard time
all year.

## Notes

- A dated status above the history that is newer than every row becomes the newest scan.
- The estimate is a day or a window of two days, until a delivery.
- The receiver's suburb and postcode, the name the delivery was received by and the item counts are not read.
- Locations are the tracker's depot codes.

## Limitations

- No provider codes, service name or proof of delivery.
- Pickup, out-for-delivery, exception and return wordings have not been seen on the tracker; they fall to the
  shared wording rules.

## Links

The tracker takes the number in its path.

## Testing

```sh
npm run test:carriers:live -- carriers/vt-freight-express
```

It reads the public sample from `numbers.json`; `VT_FREIGHT_EXPRESS_TRACKING_NUMBER` and
`VT_FREIGHT_EXPRESS_UNKNOWN_NUMBER`, set outside the repository, replace the sample and the synthetic number.
