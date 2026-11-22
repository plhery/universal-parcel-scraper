# Activos24

Activos24 delivers parcels in Portugal from its base in Frielas. Select it explicitly to track a shipment by its twelve-digit code, including leading zeroes.

## Retrieval

The Portuguese tracking page, `/pt/seguir-encomenda`, returns a shipment card and a table of dated scans. Activos24 runs an older version of Logisimple's portal software, so its adapter uses the same reader with the Activos24 host, path and status wording. The reader matches the code in the card heading and keeps warehouse names and local scan times. An unknown code gets "Envio não encontrado." under the search form, which counts as not found only when the form echoes the requested code.

The page gives no estimate. Proof of delivery, the sender's reference and the service stay out of the tracking result. The delivered fixture is the result card from the public sample listed in numbers.json; the unknown fixture answers the form's own example code.

## Testing

Set `ACTIVOS24_TRACKING_NUMBER` and `ACTIVOS24_UNKNOWN_NUMBER`, then run `npm run test:carriers:live -- carriers/activos24`.
