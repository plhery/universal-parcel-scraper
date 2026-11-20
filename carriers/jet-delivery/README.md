# Jet Delivery

Select Jet Delivery and enter the numeric tracking number from the shipment confirmation. The adapter calls the company’s public tracking endpoint and checks the returned `track_no`. [Official tracker](https://www.jetdelivery.com/track/) · [Public API guide](https://www.jetdelivery.com/developer/guides/tracking/)

The adapter uses the carrier’s summary status and offset-bearing timestamp. It keeps dated public movement and scheduling phrases, with scan locations reduced to city and state. Dispatch and departure refer to the driver, so those lines carry no explicit shipment stage. The parser projects only status, clocks and those event phrases from the response.

Both published examples returned current shipment details. One showed delivery, and the other now shows the cancellation recorded after the example was written.

```sh
JET_DELIVERY_TRACKING_NUMBER=3765352 JET_DELIVERY_UNKNOWN_NUMBER=00000000 npm run test:carriers:live -- carriers/jet-delivery
JET_DELIVERY_TRACKING_NUMBER=3766585 npm run test:carriers:live -- carriers/jet-delivery
```
