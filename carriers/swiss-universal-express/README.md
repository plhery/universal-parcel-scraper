# Swiss Universal Express

Swiss Universal Express (SUE) is a Geneva carrier for businesses that send parcels between ten
European countries. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://swiss-universal-express.ch/tracking/{number}?lang=en`. The page is
   rendered on the server behind Cloudflare; no cookie, form token or browser is needed.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the
   budget.

Recognition asks the same page.

- Only a page that names the whole number asked is read; a page for another number is
  indeterminate.
- A number the tracker does not hold gets HTTP 200 and the notice "The number you entered is
  incorrect." Only that answer is not found. The tracker words any input it does not hold so,
  whatever its shape, so the adapter refuses before asking a number outside SUE's layout. A
  redirect or an error status is a moved route, a Cloudflare check is a challenge, and any other
  page is a schema failure.

## Notes

- The adapter reads the English page; `lang` also takes fr, de and it. The English page names
  the rows' countries in English, which the place reader resolves where the German name does
  not, and wording the map lacks falls to the shared English rules. The French page writes the
  same rows day first, which shows that the English dates give the month first.
- Rows give a month, a day and a time, without a year or a zone. The time is the facility's
  wall clock and stays a local time, dated by the row's country. The year is the latest that
  puts the row no later than a day after the lookup, a day being room for the clocks of the
  countries SUE serves.
- [`status.ts`](status.ts) stages the rows and the summary's status by their wording; other
  wording goes through the shared rules. The newest row with a stage decides, then the
  summary's status above the rows, then the furthest of the progress bar's five steps the page
  marks as reached.

## Limitations

- No public sample shows a delivery; one rests on the shared rules and the progress bar's last
  step.
- A history whose newest row is more than a year old is dated in the latest year its days fit.
- No delivery estimate, weight, service or delivery partner.

## Numbers

SUE's numbers are SUE, thirteen digits and two letters. The only public number ends in FR, so
the rule takes that suffix alone, with low confidence, and recognition asks the tracker. The
adapter asks about any two letters, as the suffix may name another country SUE serves. The
sample and its source are in [`numbers.json`](numbers.json).

## Links

`swiss-universal-express.ch/tracking/{number}?lang=en` opens one parcel on the English tracker,
and the search page is the tracker without a number. The site has no help or contact page, only
an address hidden behind Cloudflare's email protection, so there is no help link.

## Testing

`npm run test:carriers:live -- carriers/swiss-universal-express`, with
`SWISS_UNIVERSAL_EXPRESS_TRACKING_NUMBER` and optionally `SWISS_UNIVERSAL_EXPRESS_UNKNOWN_NUMBER`
set outside the repository.
