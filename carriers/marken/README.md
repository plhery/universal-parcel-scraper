# Marken

Marken is a parcel and freight network within UPS Healthcare. Its public tracker accepts
a Marken job reference by itself. Select Marken explicitly or paste the carrier’s
[tracking link](https://www.marken.com/track-shipment).

## How it works

The adapter gets the carrier’s `/track-shipment?jobNumber=…` page. Both the search field
and the result’s Tracking ID must match the submitted reference. The current status and
scan list are available in the returned HTML. The adapter uses the English page.

## Notes

- Scan dates are recorded as displayed local clocks. The carrier’s scan order is kept
  because a trip can cross time zones. The current-status banner determines the stage
  when it supplies one.
- “Dispatch Courier to Pickup” and “Pickup Package” in a numeric job can describe a
  planned pickup. “Collected on” confirms possession.
- The weight is reported only when the carrier explicitly displays kilograms. The
  adapter omits signatures, addresses, collection and delivery appointments, and
  private shipment details.

## Limitations

Both numeric and alphanumeric Marken job references are supported. A bare reference
requires carrier selection. The carrier displays route origin and destination separately
from its timeline. Those values are omitted from the scan locations.

## Testing

```sh
npm test -- carriers/marken
MARKEN_TRACKING_NUMBER=<published-number> npm run test:carriers:live -- carriers/marken
npm run test:search-pages -- -t marken
```

The fixtures come from indexed Marken shipment pages. A published tracking link was
also verified in a phone-sized browser.
