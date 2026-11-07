# City Air Express

Guest parcel history from City Air Express’s Belfast NetCourier portal. The official site
routes tracking there, including the confirmed MN series; the depot prefix does not select a
host. Other series and depot hosts remain with enabled universal providers.

## Retrieval

A bounded GET reads `/online/tracking/trackinginfo/{trackingNumber}`. The complete waybill must
match the `TRACKING FOR` heading before any dated event is read. Only the exact number-bound
“Sorry, we could not find job” notice is not found. Redirects, route failures, blocked pages and
malformed history remain distinct failures. One network-only retry shares the lookup budget.

The request selects British English explicitly. NetCourier's locale handling returns a server
error for Node's default language header before rendering the tracking response.

The adapter reads the dated logistics rows, removes exact duplicates and preserves their order.
The progress rail, recipient and signature prose, hidden forms and postcode-protected details
are excluded. Scan times retain their full year and minute precision without an inferred zone;
no delivery instant or estimate is supplied. Data processing records label activity, not custody.
Unrecognized wording becomes a generic update; the scan is still there, so the history is not marked cut short.
All source rows are validated before the output cap.

## Scope

The MN series has a shared eligibility gate for direct tracking and HTTP recognition. Its
existing low-confidence detection stays unchanged; other carriers can issue a similar shape.
A whole confirmed waybill without dated history is known to recognition but supplies no history.
The public reference demonstrates retained history, not current shipment recognition coverage.

## Testing

Set `CITY_AIR_EXPRESS_TRACKING_NUMBER` and optionally `CITY_AIR_EXPRESS_UNKNOWN_NUMBER` outside
the repository, then run `npm run test:carriers:live -- carriers/city-air-express`.
