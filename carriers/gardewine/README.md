# Gardewine

Select Gardewine explicitly and enter your shipment number from the [guest tracker](https://gardewineweb.gardewine.com/scripts/cgiip.exe/main-frame.htm?language=ENGLISH&nav=top).

## Retrieval

The adapter opens the guest shipment detail page and checks the shipment number printed on the result. The legacy tracker can return a different reference for an invalid search. The adapter rejects that reply before parsing any events.

The dated movement table supplies the status, terminal and printed local time. Manifest creation stays unstaged. The fixture retains the shipment reference and history and omits signed delivery and address data.

## Testing

`GARDEWINE_TRACKING_NUMBER=… GARDEWINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/gardewine`
