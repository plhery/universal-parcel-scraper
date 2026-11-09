# MOVIN

MOVIN parcels use enabled universal providers. There is no dedicated adapter.

MOVIN operates business-to-business express delivery in India, through a joint venture
of UPS and InterGlobe Enterprises.

## Retrieval

The [official tracking page](https://www.movin.in/shipment/track) embeds Shipsy's
`/track/result` page. It asks for the new tracking ID as a reference number and opens
it from `refNum`, with `searchBy=referenceNumber`. The `/p/track` route also accepts
those parameters.

The guest page handles Turnstile and posts to
`https://onlinebookingmultitenantbackend.shipsy.in/agent/consignment/getAgentPublicConsignments`.
Its body contains `numbers`, `searchMeta.searchBy=reference_number` and `captcha`;
`organisation-pretty-name` and `organisation-url` select MOVIN's portal. A request
without the verification token is rejected. No usable public shipment reference
establishes the dated event schema.

The [official Android app](https://play.google.com/store/apps/details?id=org.movin.logistics)
uses `https://movinocrapiprod.movin.in/api/` for shipment creation and label printing.
Its `Shipment/Details` POST sends `shipment_number` and returns booking and label data,
without a tracking-event model. Driver login and OTP operations belong to the app's
account flow.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
