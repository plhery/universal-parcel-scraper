# BoxC

BoxC parcels use enabled universal providers. There is no dedicated adapter.

BoxC is the brand of BoxC Logistics, Inc. in New York. It consolidates e-commerce parcels in
China, scanning them in Shenzhen, and hands them to USPS, DHL eCommerce or other final-mile
carriers. Its site is boxc.com.

## Numbers

BoxC tracks a shipment by its final-mile number or by the number of its own generic label. The
final-mile numbers belong to USPS, DHL eCommerce and other carriers, and no public page shows a
generic label number, so there is no rule.

## Why there is no adapter

Its tracking page is a JavaScript app that posts the number to `www.boxc.com/api/track` and shows
the first, middle and last mile as one history. No public number is known to see a found reply.

## Links

`boxc.com/track/<number>` opens one shipment. The link names BoxC only for its own numbers, so a
final-mile number in it is detected on its own.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
