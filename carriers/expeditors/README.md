# Expeditors

Expeditors International of Washington is a freight forwarder and customs broker that moves air and ocean
freight. The adapter tracks a shipment by its Expeditors reference through the guest tracker at
go2expo.expeditors.com.

## How it works

1. `direct`: the requests the guest tracker sends from the browser, to `https://go2expo-api.expeditors.com/api/visibility`.
   `GET /guest-shipment-search?searchReference={number}` finds the shipment, then
   `GET /shipment-detail/{number}/events` reads its events, and `/details` its status when the search listed
   several shipments. No cookie, token, CAPTCHA or browser. The two detail requests share the budget and a failed
   one ends the other.
2. `retry`: the whole read once more when it fails to reach the service or hangs. The first try gets half of the
   budget, so the retry fits in the rest.

- The search answers `{"shipmentResults":[]}` for a reference it does not hold: that is not found. It answers
  the shipment itself when one matches, and a list when several do.
- The search also matches customers' references, such as orders and invoices. Only a shipment whose
  `expeditorsReference` is the number asked is read; a search that found only other shipments is
  inconclusive with reason `reference_only`, and nothing of those shipments is kept.
- A redirect or a 404 is a moved service, a firewall page is a challenge and a 429 is a rate limit.

## Notes

- Each event gives its instant in UTC and the wall clock it reads where it happened, with a zone abbreviation.
  The difference between the two is the event's offset, kept when it is a whole quarter hour; otherwise the
  instant stays in UTC. Older replies leave the year out of the wall clock.
- The shipment's last status change is missing from the events section, so it is added as a scan.
- Rows starting "Est" or "Estimated", and the requested delivery date, are estimates: they become planned
  events and the delivery estimate, and are dropped once the shipment is delivered.
- An event names a place only when it names one end; a leg from one place to another gives no place.
- "Services Completed: Turned Over to Client Trucker" is delivered: Expeditors handed the freight to the
  trucker its client sent and its service ended.
- The parties, the customer references, the airline or shipping line with its flight or voyage, the pieces, the
  volume and every event's remarks are never read.

## Limitations

- The guest search drops a shipment some months after it ends.
- No proof of delivery or delivery address.

## Numbers

An Expeditors reference is its branch's two digits, then a letter or a digit and seven digits. The shape is
shared with Australia Post's numbers and with many carriers' ten-digit numbers, so no detection rule offers
Expeditors.

## Links

The guest tracker opens a shipment from `anonymous-track/tracking-results/shipments/{number}`.

## Testing

`npm run test:carriers:live -- carriers/expeditors` tracks the public samples, or the reference in
`EXPEDITORS_TRACKING_NUMBER`, skipping when the guest search holds none of them, and checks an invented
reference, or the one in `EXPEDITORS_UNKNOWN_NUMBER`, reads as not found.
