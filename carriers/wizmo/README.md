# Wizmo

Wizmo parcels use enabled universal providers. There is no dedicated adapter.

Wizmo is a Canadian cross-border e-commerce consolidator. It moves parcels into and out of Canada
and the US and hands them to a final-mile carrier such as DHL eCommerce, Canada Post or UPS. Its
site is shipwizmo.com.

## Numbers

Its references are `WD` and ten digits, which `wizmo-1` suggests at low confidence; the Aramex
rules for two letters and ten digits share the shape. Its tracker also answers the final-mile
carrier's number, which stays with that carrier.

## Why there is no adapter

The current tracking page requests `GET /api/track-shipment?tracking_code=` on shipwizmo.com
without an account or secondary input. Archived shipment replies belong to the older
`/api/v1/portal/track/` interface; they do not verify the current endpoint's identity, partner
fields or scan clocks. No current public positive is known, so native retrieval remains disabled.

## Links

The tracking page opens a reference from its path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
