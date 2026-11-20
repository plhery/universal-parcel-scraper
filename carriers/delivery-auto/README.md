# Delivery

Delivery is a Ukrainian road carrier. The adapter tracks domestic freight receipts when the
caller selects Delivery. The site also searches pickup requests by a separate identifier.

## Retrieval

The adapter posts the receipt to `/uk-UA/Receipts/DetailsNew`, using the same fields as the
public search. The returned receipt must show the complete number. The site's empty reply means
it found no receipt. A reply of `1` means the reference matched several receipts.

Guest tracking provides the current status and, when present, its local clock. Detailed history
requires signing in. The public route dates describe transport between branches and are omitted
from the delivery estimate.

## Testing

`DELIVERY_AUTO_TRACKING_NUMBER=… DELIVERY_AUTO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/delivery-auto`
