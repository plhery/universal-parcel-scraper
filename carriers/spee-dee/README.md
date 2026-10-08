# Spee-Dee

Spee-Dee serves its regional US delivery network. Parcels use the
[universal providers](../../providers/README.md).

## Retrieval

The [official tracking page](https://speedeedelivery.com/track-a-shipment/) embeds
`https://packages.speedeedelivery.com/track_shipment.php`. The tracking host must
be reachable independently of the main website. No dedicated adapter reads it.

## Limitations

A timeout or blocked tracking frame does not establish that a parcel is missing.
Provider results need matching shipment activity; the public page loading by
itself does not confirm carrier ownership or tracking availability.

## Testing

Provider live-test inputs and commands are documented in the
[provider READMEs](../../providers/README.md).
