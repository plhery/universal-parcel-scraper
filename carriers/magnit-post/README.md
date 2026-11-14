# Magnit Post

Magnit Post parcels use enabled universal providers. There is no dedicated adapter.

Magnit Post (Магнит Пост), run by ООО «Магнит Маркет» of the Magnit retail group, delivers online
shops' parcels to pickup points in Magnit stores and by courier, in more than 900 Russian towns.

## Numbers

Its tracker finds a parcel by the shop's order number or the parcel's barcode. No public page
shows a whole number or its layout, so there is no rule.

## Why there is no adapter

The tracker asks for the last four digits of the recipient's phone as well as the number. With no
public number to check its replies against, there is no adapter.

## Leads

The page calls `GET https://b2b-api.magnit.ru/api/v1/magnit-post/orders/track` with `orderId` and
`phoneSuffix`, the four phone digits. A found order redirects to its details page; an unknown one
answers 404.

## Links

The tracker needs the phone digits with the number, so no address opens one parcel and the catalog
sends people to the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
