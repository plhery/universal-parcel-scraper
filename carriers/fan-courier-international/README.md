# FAN Courier International

FAN Courier's international service has its own tracker at fancourier.eu, separate from the
Romanian network's AWB tracker. The adapter asks the status API behind that tracker's page.

## How it works

1. `direct`: one JSON POST of the number to `https://fancourier.eu/API/status`, which needs
   neither the page's session nor its XSRF token. HTTP 401 or 404 with `NOT_FOUND` naming the
   same number is not found. A 422 refusal, a reply naming another shipment, a browser check and
   a rate limit keep their own failure kinds.

## Notes

- Numbers are sixteen digits, an F and four digits, the number the reply echoes as the
  shipment's request number. The tracker also answers for its internal shipment number and for
  the FAN Courier AWB of the Romanian leg; the adapter asks for neither.
- Each event's instant is `event_date`, the Unix seconds the page shows, placed on Bucharest
  time. Its `date` is the Bucharest wall clock the system wrote the event at, half an hour later
  for a code received from the network, and is only used when an event has no epoch.
- A received code and the status change it brings share an instant, the code first, so the
  current stage follows the reply's headline: a settled status, else its last code, else its
  status.
- Postal Ninja names these shipments "FAN Courier"; for a number of this shape that name points
  to this carrier. Royal Mail's 21-character 2D references leave the shape out.
- A provider also reports the service as "FAN Courier (EU)", which is kept as an alias.

## Limitations

- No public sample number is known, so detection only suggests the carrier.
- The weight, the related and return numbers and the franchise's nested reply are not read.
- The page takes a number only from its own form post, so the portal link opens the empty form.

## Testing

`npm run test:carriers:live -- carriers/fan-courier-international`, with
`FAN_COURIER_INTERNATIONAL_TRACKING_NUMBER` and optionally
`FAN_COURIER_INTERNATIONAL_UNKNOWN_NUMBER` supplied outside the repository.
