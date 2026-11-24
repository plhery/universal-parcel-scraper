# Runner Express

Runner Express is an Israeli importer of cross-border e-commerce parcels: customs, warehousing
and delivery through last-mile partners. Its site is runnerexpress.co.il. Its tracker follows a
parcel from Runner Express's warehouse at the origin, through the flight and customs, to its
sorting center in Israel and the delivery partner's steps.

## Numbers

The waybills seen are ZYIL and thirteen digits. One public sample is too few to claim that
shape, so no rule names Runner Express. The adapter takes 6 to 40 letters and digits with at
least one digit. The samples and their sources are in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://runnerexpress.co.il/track/?search_query={number}`, what the
   tracking form on the site's home page sends: its one field, with no cookie, token or browser.
   The reply is an English HTML page.
2. `retry`: a read that fails to reach the site, or hangs, is sent once more within the budget.
   The first try gets half of it.

A parcel's page has a summary (the waybill number, the newest scan's clock and wording, and its
offset) and "Web Tracking Details", one line per scan, newest first: a clock to the second, the
offset, and the wording. The summary must name the whole number asked.

A number the tracker holds nothing for gets "This logistics item was not found" in place of
both, read as not found. The page does not repeat the number, but the request is a stateless
GET, so the answer is the number's. The page answers every number with HTTP 200: a 403 is a
refusal, a redirect or a missing route a moved tracker, and a page without the tracker's
content a changed one, or a challenge when it is a firewall's.

There is no recognition: no detection rule offers Runner Express, so preflight never asks it.

## Clocks

Each scan states its offset, as `UTC+8:00` or `UTC+08:00`, and the adapter keeps it in `time`:
the origin warehouse and the flight's departure state UTC+8, the landing, customs and the scans
in Israel UTC+2. Israel's scans state UTC+2 in summer too, when the country is on UTC+3; the
instant is the one the page states. A line without an offset keeps its wall clock in
`local_time`.

## Status

Scans carry wording only, staged by the map and else by the shared wording rules. The parcel
waiting at a service point, which the page repeats every few days, is ready for pickup, and the
way back from it is the return from its first step. Wordings keep the carrier's spelling.

## Limitations

- No place, delivery estimate, weight or proof of delivery.
- The page names no delivery partner or partner number, so there is no hand-over.
- The map holds the wordings seen with the sample. Delivery, failed attempt and exception
  wordings have not been seen; they fall to the shared wording rules.
- A page whose summary names a waybill other than the number asked, as a lookup by another
  reference gives, is inconclusive.

## Links

The tracker opens a number from its `search_query` parameter.

## Testing

```sh
npm run test:carriers:live -- carriers/runner-express
```

It reads the public sample from `numbers.json`; `RUNNER_EXPRESS_TRACKING_NUMBER` and
`RUNNER_EXPRESS_UNKNOWN_NUMBER`, set outside the repository, replace the sample and the
synthetic number.
