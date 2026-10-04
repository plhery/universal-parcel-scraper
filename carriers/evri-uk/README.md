# Evri UK

Domestic UK parcels. Evri International stays under [evri](../evri/README.md).
Automatic history uses the universal providers enabled by the caller.

## How it works

The official page resolves a barcode through the customer-tracking search or
platform reference API, then reads the parcel's history by its returned URN.
Both APIs use rotating keys issued by a page request protected by AWS WAF.
The key request can fail with HTTP 403 in plain HTTP and a fresh Chromium
session, leaving the tracking application without parcel data.

## Notes

- A barcode can resolve to an international redirect. Its format alone does
  not establish a domestic shipment.
- An international not-found is not an Evri UK not-found.
- Public tracking URLs are recognized separately from international tracking.

## Limitations

No dedicated adapter is registered. The official page's key bootstrap must
work before a direct history implementation can be validated.

## Testing

Provider live-test inputs and commands are documented in the
[provider READMEs](../../providers/README.md).
