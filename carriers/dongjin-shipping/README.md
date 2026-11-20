# Dongjin Shipping

Select Dongjin Shipping explicitly and enter a container number in the same format as the [guest cargo tracker](https://esvc.djship.co.kr/gnoss/CUP_HOM_3301.do?sessLocale=en). The adapter accepts spaces and the separator before the check digit.

## Retrieval

The guest container query returns one booking and movement reference for the equipment. The adapter supplies both references and the exact container to the movement query and checks the returned movement reference on every row. In the observed reply, `A` marks an actual movement and `E` marks an estimate. Events retain the port's printed clock, location and movement code. An empty equipment release carries no shipment stage. Loaded gate-out from a terminal counts as transit.

The default transport uses Node’s HTTPS client with its normal certificate store because the site redirects the standard Fetch request to the e-service home page. The guest lookup describes the equipment's current booking. It can change as the container is used for other cargo. The fixtures replace the two internal references with consistent test values.

## Testing

`DONGJIN_SHIPPING_TRACKING_NUMBER=… DONGJIN_SHIPPING_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/dongjin-shipping`
