# CTM Messagerie

CTM Messagerie is the parcel service of CTM, Morocco's national coach company, with agencies across
the country.

## Numbers

Its tracker takes the receipt number printed on the shipping declaration. The public sample is
seven bare digits, a shape many carriers print, and CTM publishes no layout, so there is no rule and
preflight never asks it.

## Retrieval

The tracking page posts the number as the form field `ndesuivi` to `ctm-messagerie.ma/fr/suivi-du-colis`
and answers in place, with no session, key or CAPTCHA. Its result section gives the receipt number,
the date of dispatch, the recipient's name and town, and the history, newest first: each row's date
and time, its French status and the agency that wrote it.

- The result must name the number asked.
- A row's time is Morocco's wall clock without an offset, and is kept as `local_time`.
- The recipient's name and town and the date of dispatch are not read. The page also carries
  commented-out sample rows, which are not history.
- Only the page's alert that no parcel matches the search is not found. It mentions parcels sent in
  the last 60 days, but the tracker answers older ones. A block page is a challenge, and any other
  page is a changed reply.

## Links

The tracking form posts the number, so there are no tracking links.

## Testing

`npm run test:carriers:live -- carriers/ctm-messagerie`

The live test tracks the sample in `numbers.json` and checks the not-found answer;
`CTM_MESSAGERIE_TRACKING_NUMBER` tracks another number, and `CTM_MESSAGERIE_UNKNOWN_NUMBER`
another unknown one.
