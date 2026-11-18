# Garudavega

Garudavega is an international courier in Hyderabad, India. It sends parcels and documents from
India to families abroad, in the United States, the United Kingdom, the United Arab Emirates,
Australia, Canada and other countries, from branches across India. Its site is garudavega.com.

## Numbers

The only public example is eleven digits, from an aggregator. Eleven-digit runs are other
carriers' numbers too, so there is no rule.

## Retrieval

The guest page renders the shipment number and its scans in HTML. The adapter checks the shipment heading and reads the dated timeline in page order. Scan clocks have no offset and can span countries, so they keep their local time. The fixture contains the heading and timeline from the public example listed in `numbers.json`.

## Testing

`GARUDAVEGA_TRACKING_NUMBER=… GARUDAVEGA_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/garudavega`
