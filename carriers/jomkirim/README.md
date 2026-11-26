# Jomkirim

Jomkirim (JOMKIRIM COURIER) is a Malaysian courier booking service with parcel drop-off points
around Malaysia. Tracked through its tracker's shipment page.

## How it works

1. `direct`: one `GET https://courier.jomkirim.com/shipment/tracking/{code}`, the page the tracking
   form opens. It needs no key, token or browser. The server renders the shipment's code, its
   current status and its history, oldest first.
2. `retry`: the same read once more, with a new session, after a request that failed to reach the
   tracker or hung. The first try gets half of the budget.

- A code the tracker does not know is a redirect to the tracking form, which shows `Invalid
  shipment code` to the session that asked. The adapter follows it with that session's cookie;
  that notice is not found. The form without it is inconclusive, and a redirect anywhere else,
  such as the login page, a 404 or a 410 is a moved route.
- The page's heading must name the code asked. The tracker matches codes in any case; the
  adapter asks in capitals.
- A 403 or a bot check's page in place of the tracker, even with HTTP 200, is a challenge.

## Notes

- Each row gives how long ago it was, then its date and time on the tracker's wall clock with no
  zone. Only the bracketed clock is read, as `local_time`. Malaysia keeps one zone, so consumers
  date the rows by the catalog's clock.
- The rows have no code: `statuses.json` maps their wordings. The current status heads the page
  and sets the stage; a wording no rule reads leaves it to the newest staged row.
- The two cells after each row's wording are empty on every page seen and are not read.
- The page can link "Detailed Partner Tracking" to a partner's page on tracking.my. The link
  carries Jomkirim's own code, which the partner's tracker does not know, so it is not reported
  as a delivery partner.

## Limitations

- No places, instants, expected delivery, weight, service or proof of delivery.

## Numbers

Shipment codes are the courier script's prefix and a serial: the public sample is `AWB` and
digits, and the form's placeholder shows another prefix. Short generic codes like these cannot
point to Jomkirim alone, so no detection rule offers it. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking form opens `courier.jomkirim.com/shipment/tracking/{code}`, and its `code`
parameter redirects there; the library reads the code from either.

## Testing

`npm run test:carriers:live -- carriers/jomkirim` tracks the public sample, or the code in
`JOMKIRIM_TRACKING_NUMBER`, and checks an invented code, or the one in `JOMKIRIM_UNKNOWN_NUMBER`,
reads as not found.
