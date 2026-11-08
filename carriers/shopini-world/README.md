# ShopiniWorld

ShopiniWorld parcels use enabled universal providers. There is no dedicated adapter.

ShopiniWorld is a shop-and-ship service run by Shopini Logistics in Dubai. It gives shoppers
addresses in the United States, the United Kingdom, the UAE, Turkey and China, consolidates their
purchases and ships them on to the Gulf and worldwide. It is not the Iraqi marketplace at
shopini.com. Its site is shopiniworld.com.

## Numbers

Its parcel IDs have no published layout, and no public page shows one, so there is no rule.
Shoppers can also send a parcel with a partner courier, which then travels on that courier's own
number.

## Why there is no adapter

Its tracking page is a JavaScript app with a parcel ID form. The app reads its results as JSON
from `GET parcels-uat.shopiniworld.com/api/orders-parcels-shopini/tracking?tracking_number=<number>`,
a host named as a test environment. No public number is known to see a found reply.

## Links

The tracking page reads the ID only from its form, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
