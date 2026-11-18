# Transportes Rapex

Transportes Rapex carries urgent shipments in Portugal and across Iberia. Select it explicitly to track a shipment by its twelve-digit code, including leading zeroes.

## Retrieval

The Portuguese tracking page returns a shipment card and a table of dated scans. Rapex shares Logisimple’s portal software. Its adapter uses the same reader with the Rapex host and its own Portuguese status wording. The reader matches the code in the card heading, keeps warehouse names and local scan times, and drops duplicate scans. A no-match notice must name the requested code.

The estimate supplies a day while the shipment is moving. Proof of delivery and contact details stay out of the tracking result. The delivered fixture is the result card from the public sample listed in numbers.json.

## Testing

Set `TRANSPORTES_RAPEX_TRACKING_NUMBER` and `TRANSPORTES_RAPEX_UNKNOWN_NUMBER`, then run `npm run test:carriers:live -- carriers/transportes-rapex`.
