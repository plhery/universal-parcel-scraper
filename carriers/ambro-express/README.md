# Ambro Express

Tracks the Polish courier's oversized parcels, including cross-border deliveries.

## Retrieval

The public tracking form posts one shipment number and the fixed form action
value `send` to the tracking page. The JSON reply contains the history table
for that submission and carries no separate shipment identifier. The form's
`Nie znaleziono` response means it could not find the shipment.

The table gives dates, local clock times and statuses in Polish. It gives no
scan locations or offsets.

## Numbers

Select Ambro Express explicitly or open its tracking page with the shipment number
in the URL fragment.

## Testing

`AMBRO_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/ambro-express`
