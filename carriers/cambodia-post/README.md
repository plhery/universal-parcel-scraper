# Cambodia Post

Select Cambodia Post to read the history of a postal item in Cambodia, mostly items sent to
Cambodia from abroad, from the tracking page on its site. Postal detection stays with the
international-mail carrier: no rule or recognition sends item codes here.

## How it works

1. `direct`: one `GET https://www.cambodiapost.com.kh/tracking/search?search={number}`, as the
   site's tracking form sends it. It needs no account, cookie, token or browser. A heading names
   the item, which must be the whole requested code, and a table lists its scans, newest first.
2. `retry`: a lookup that fails to reach the site, or hangs, is sent once more within the budget.
   The first try gets half of the budget.

- A code the tracker holds nothing for gets a single "Not Found" row under the heading, which is
  not found. Any other lone row, or an empty table, is a changed page.
- A firewall or bot-check page, even with HTTP 200, is a challenge, a 429 a rate limit and a 503
  maintenance. A redirect, which is how the site sends guests to its login, a 404 or a 410 is a
  moved route.

## Notes

- The page comes in Khmer unless `/lang/en` set the session's language first. Only the headings
  change: the event names are IPS's English ones either way, so the adapter makes one request and
  reads both headings.
- The clock column is headed "Local Date and Time" and its values end in `Z`. They are the
  offices' wall clocks: read as UTC, Phnom Penh's delivery and failed attempt would fall after
  21:00 there. The adapter drops the `Z` and keeps each clock as `local_time`; a lookup dates it
  by the scan's place, Phnom Penh for Cambodian offices and the posting country's zone for its
  scans.
- Event names are the UPU IPS system's with their leg, `(Otb)`, `(Inb)` or `(EDI-received)`, and
  La Poste Burkina Faso's IPS map reads them. An inward scan gives the destination country.
- The extra information's reason, measure and retention reason follow the event name after a
  colon. The signatory a delivery names, the mail category and the next office are dropped.

## Limitations

- No ETA, weight, service, sender, recipient or proof of delivery, and no clock with an offset.
- Only an item from the Netherlands delivered in Phnom Penh has been seen. Cambodia Post's own
  outbound items, returns and customs holds have not.
- The adapter takes S10 codes with a valid check digit only.

## Numbers

No public item code issued by Cambodia Post was found, so no rule claims `KH` S10 codes.

## Testing

Supply private controls outside Git with `CAMBODIA_POST_TRACKING_NUMBER` and
`CAMBODIA_POST_UNKNOWN_NUMBER`, then run `npm run test:carriers:live -- carriers/cambodia-post`.
