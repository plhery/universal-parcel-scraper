# Intelcom / Dragonfly

Tracks Canadian Intelcom and Dragonfly shipments through the Canadian Dragonfly portal's anonymous tracking service. Dragonfly Australia and Netherlands use separate services.

## How it works

1. `direct`: GET the public Canadian tracking endpoint. A successful reply must identify the requested shipment; only the service's explicit `not_found` reply establishes absence.

Observed Canadian status codes establish milestones even when the English label is a marketing phrase. Other wording uses shared classification, with that provenance retained. Offset-bearing scan times and epoch milliseconds keep their instants. A dated current status without history is returned as a summary.

## Limitations

Merchant references can identify Intelcom shipments without an Intelcom prefix. `INTLCM` numbers, including the lettered series such as `INTLCMD` and `INTLCMJ`, are
Intelcom identifiers; the adapter sends the complete value. Detection suggests Intelcom for the `CRIN` family; shipper and merchant references need an explicit carrier or an Intelcom tracking link. Recipient addresses, driver names, proof images and delivery estimates are discarded. Local scan clocks stay unresolved because Canada spans several timezones.

## Testing

`INTELCOM_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/intelcom`
