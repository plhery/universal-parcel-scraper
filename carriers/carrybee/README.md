# CarryBee

CarryBee parcels use enabled universal providers. There is no dedicated adapter.

CarryBee Express Ltd is a courier in Dhaka, Bangladesh. It delivers the parcels of online and
social-media sellers to homes in every district of Bangladesh, with apps for merchants and
agents. Its site is carrybee.com.

## Numbers

The only public example is eleven letters and digits starting with a letter, from an
aggregator. That layout fits many carriers, so there is no rule.

## Why there is no adapter

Its tracking page is a Next.js app that reads `consignmentId` from the address and asks
`api-merchant.carrybee.com/api/v2/track-order` for that consignment.

## Links

`carrybee.com/track?consignmentId=<number>` opens one parcel. The merchant site's older
`tracking` page answers 404.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
