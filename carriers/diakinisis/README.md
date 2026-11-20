# Diakinisis

Tracks orders carried by the Greek logistics company Diakinisis.

## Retrieval

The public tracker posts the order or voucher number to `server_handler_ext.php`.
It leaves the optional second field blank. A successful response names the
requested order and contains a dated timeline. An explicit order-not-found
message is the tracker's negative result.

The scans keep the Greek wording and local clock times from the timeline. The
adapter reads shipment history without requesting delivery documents or images.

The default Node transport supplies the DigiCert intermediate that the
tracking host omits from its TLS handshake. The host's certificate is still
verified against Node's trusted roots.

## Numbers

Select Diakinisis explicitly. A response that names a different order or voucher
requires separate evidence that the numbers refer to the same shipment.

## Testing

`DIAKINISIS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/diakinisis`
