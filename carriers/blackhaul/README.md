# Blackhaul

Blackhaul, Blackhaul Intermodal Logistics, carries freight across Australia by air and road from
Western Australia. Its site is blackhaul.com.au. Tracked through its portal on Transvirtual, the
consignment software behind its tracking page.

## How it works

1. `direct`: one `GET https://portal.transvirtual.com/Track/654472/{number}`. 654472 is
   Blackhaul's portal code, the one its tracking page gives Transvirtual's widget, and the page
   carries Blackhaul's logo. It needs no cookie, token, key or browser. The page is the template
   [VT Freight Express](../vt-freight-express/README.md)'s and
   [Hunter Express](../hunter-express/README.md)'s trackers serve, and VT Freight Express's reader
   in [`transvirtual.ts`](../vt-freight-express/transvirtual.ts) reads it: a heading with the
   current status, the consignment's details and the history table, oldest first.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The page must be portal 654472's and its details must name the whole number asked.
- A number the tracker has no consignment for gets its empty search form with "Missing or
  incorrect tracking number", under an id built from the address asked, so the answer counts only
  when that id repeats the number. The software gives the same answer for consignments it has
  dropped, as VT Freight Express's archived samples show, so it is inconclusive
  (`portal_not_found`), not a missing parcel.
- The page answers every number with HTTP 200, so a 404 or a redirect is a moved route and a 403 a
  refusal.
- No recognition: the tracker never says a number is unknown.

## Why not the widget

blackhaul.com.au/track/ embeds Transvirtual's simple tracking widget, which asks
`portal.transvirtual.co/Widget/TrackSimpleContent` with the widget's public code and the portal
code, and gets JSONP, JSON or XML around an HTML fragment. That fragment is another template: every
status of the consignment with its clock, dispatch steps such as a driver's assignment among them,
and no places. Its answer for an unknown number, "Invalid Query, enter valid tracking number",
does not repeat the number, and it gives the same answer for dropped consignments. The portal page
shows the same consignment with its depots and binds its answers to the number.

## Numbers

No public page shows a Blackhaul consignment number, so there is no rule and Blackhaul is asked
only when it is selected or a tracking link names it. Transvirtual consignments open with a prefix
set per sender, so the adapter sends six to thirty letters and digits, as the other Transvirtual
readers do.

## Clocks

History rows group the scans of one kind at one depot on one day and show only the day. The address
of each grouped row's detail panel carries the group's scans as UTC ticks, so the first of them is
the row's instant; it is used only when the address names the row's wording, depot, day and
consignment and falls on the row's day in an Australian zone, otherwise the row keeps its day as
`local_time`. Timed rows and a dated status above the history show the zone's abbreviation; the
five Australian abbreviations give the offset, and another keeps the wall clock.

## Notes

- A dated status above the history that is newer than every row becomes the newest scan.
- The estimate is a day or a window of two days, until a delivery.
- The status map holds the wordings VT Freight Express's and Hunter Express's trackers show and
  the delivery statuses Transvirtual's help documents. Another wording falls to the shared rules.
- The receiver's suburb and postcode, the name the delivery was received by, the item counts and
  the map's points are not read.

## Limitations

- The found path rests on synthetic fixtures in the template other Transvirtual portals serve:
  Blackhaul's portal settings may show other fields or wordings.
- No provider codes, service name or proof of delivery.

## Links

`portal.transvirtual.com/Track/654472/` followed by the number opens one consignment, and so does
`blackhaul.com.au/track/?cn=` followed by the number: the widget sends the page's address, and
Transvirtual looks up its `cn` parameter.

## Testing

```sh
npm run test:carriers:live -- carriers/blackhaul
```

`BLACKHAUL_TRACKING_NUMBER`, set outside the repository, adds the found case;
`BLACKHAUL_UNKNOWN_NUMBER` replaces the synthetic number.
