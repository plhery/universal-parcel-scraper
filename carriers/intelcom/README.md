# Intelcom / Dragonfly

Tracks Canadian Intelcom and Dragonfly shipments through the Canadian Dragonfly portal's anonymous tracking service. Dragonfly Australia and Netherlands use separate services.

## How it works

1. `direct`: GET the public Canadian tracking endpoint. A successful reply must identify the requested shipment; only the service's explicit `not_found` reply establishes absence.

English milestone labels are classified by the shared wording rules, with that provenance retained. Offset-bearing scan times and epoch milliseconds keep their instants. A dated current status without history is returned as a summary.

## Limitations

Success parsing follows the public website's response contract. A current shipment is needed to verify live history. Recipient addresses, driver names, proof images and delivery estimates are discarded. Local scan clocks stay unresolved because Canada spans several timezones.

## Testing

`INTELCOM_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/intelcom`
