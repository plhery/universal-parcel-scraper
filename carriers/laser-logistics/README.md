# Laser Logistics

Laser Logistics parcels use enabled universal providers. There is no dedicated adapter.

Laser Logistics is The Laser Group's contract logistics, warehousing and retail distribution
business in South Africa, with its own fleet in the main centres. Its site is laserlogistics.co.za.

It is not DPD Laser (Dawn Wing), the group's courier, which is
[DPD South Africa](../dpd-za/README.md) in the catalog. Laser Logistics has its own waybills and
tracker, so it has its own entry and no Laser alias.

## Numbers

The public example is three letters and eight digits. Only an aggregator's example shows it, so
there is no rule.

## Why there is no adapter

Its tracking page is a GET form that takes `waybillnumber`. No found page has been seen.

## Links

`www.laserlogistics.co.za/parcel-tracking/?waybillnumber=<number>` opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
