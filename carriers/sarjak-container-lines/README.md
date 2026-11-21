# Sarjak Container Lines

Sarjak Container Lines is an Indian container line and project carrier, with services from India
to the Gulf, the Mediterranean and East Asia. Tracked through iTrack, the tracking page its home
page's form opens for a container, a bill of lading or a booking.

## How it works

1. `direct`: `GET https://eservices.sarjak.com/tracking/<number in base64>`, as the home page's
   form sends it. The reply lists the booking and each of its containers with its milestones. It
   needs no account or session.
2. `retry`: one more attempt when the first fails to reach iTrack or hangs. The first gets half of
   the budget, so the retry fits in the rest.

- The page loads a reCAPTCHA script, but nothing on the tracking path checks a token.
- A number iTrack holds nothing for comes back with "Tracking reference number is incorrect",
  read as not found.
- A 403 or a browser check is a challenge, a 429 a rate limit, and a redirect a moved page.

## Notes

- Each container lists the same five milestones, each marked on time, late, exception or
  forecast. The first three have happened and become events; a forecast, or a milestone marked
  not updated, has not, and becomes a planned step.
- Milestones are staged in [statuses.json](statuses.json): the empty container's pickup is
  registered, its gate-in full is acceptance, the sailing and the arrival at destination are
  transit, and its empty return is the delivery.
- A booking's containers move apart. The booking is delivered once every container is back; until
  then the latest open stage leads. Milestones the containers share are kept once.
- A reply must name the bill or booking asked for, or list the container asked for; a container
  lookup keeps only that container.
- Milestones carry a day without a time. The ports, ETA, vessel and voyage of the booking, the
  container type and the transhipment port are not read.

## Limitations

- A booking reaches iTrack only with its ports apart, as `NSA-SOH-158685`; the adapter adds the
  hyphens to a booking typed without them.
- No time of day, weight or proof of delivery.

## Numbers

Bills are the ports of loading and discharge, then eleven digits whose last six are the booking's.
Bookings are the same ports and those six digits. Containers are ISO 6346 numbers, whose check
digit is checked before the lookup. Detection has no rule. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/sarjak-container-lines` tracks the first public sample in
`numbers.json`; `SARJAK_TRACKING_NUMBER` tracks another number and `SARJAK_UNKNOWN_NUMBER` checks
the not-found answer, both set outside the repository.
