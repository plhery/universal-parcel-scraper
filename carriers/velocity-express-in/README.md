# Velocity Express

Velocity Express parcels use enabled universal providers. There is no dedicated adapter.

Velocity Express is a courier in Pune, India. It carries domestic and international courier
parcels and air freight. Its id ends in `-in` because couriers elsewhere share the name. Its site
is velexp.com.

## Numbers

The only public example is VIN and seven digits, from an aggregator, so there is no rule. Its
tracker also finds shipments by order id.

## Why there is no adapter

Its site is a script app. `/home-tracking/<number>` reads `type`, `awb` or `order`, and on load
asks `velexp.com/trackAWB/` or `velexp.com/trackOrderId/` for the number.

## Links

`velexp.com/home-tracking/<number>?type=awb` opens one shipment. With `type=order` the same
address holds an order id, which the link rule also takes as the number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
