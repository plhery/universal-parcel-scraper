# First Flight (Middle East)

Tracks air waybills from First Flight Couriers (Middle East), the UAE courier.

## Retrieval

The browser service opens the carrier's guest waybill page and captures the
tracking response for that page. The reply must name the requested waybill.
The guest API returns HTTP 403 when called directly. Its successful reply with
an empty shipment and no scans is the tracker's not-found result.

The tracker shows scan locations and separate dates and clocks. The adapter
keeps the scan clocks without assigning offsets and leaves out shipper
references and other shipment metadata.

## Numbers and evidence

Select First Flight (Middle East) explicitly or open its waybill link. The
public samples have dated histories in the archive and have expired from the
current tracker. The positive fixture projects the archive scans into the
current fields described by the tracking site's script.

## Testing

`FLARESOLVERR_URL=… FIRST_FLIGHT_ME_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/first-flight-me`
