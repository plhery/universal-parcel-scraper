# Hecny Shipping

Hecny Shipping tracks house bills of lading through its [public Track and Trace page](https://www.hecny.com/en/track-and-trace). Select the carrier explicitly and enter a single-container house bill. The adapter accepts the optional `HYSL` prefix and sends the unprefixed reference that the site expects.

## Retrieval

The adapter sets the page's `keyword` query field, then reads the tracking history from the page data. It checks the echoed search and matches the whole house bill on the container record. It follows the website's movement order and preserves the displayed clock readings, which have no numeric offset.

In-gate and out-gate scans occur during port transfers as well as at origin and destination, so they count as transit. Empty equipment pickup stays visible without changing the cargo stage. Multi-container house bills need a shipment-level interpretation of the separate histories.

Hecny’s server currently sends its leaf certificate alone. The default transport supplies the issuer intermediate for this host and keeps Node’s normal root and hostname verification. The intermediate expires in September 2035.

## Testing

`HECNY_SHIPPING_TRACKING_NUMBER=… HECNY_SHIPPING_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/hecny-shipping`
