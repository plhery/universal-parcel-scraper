# Flyt Express

Flyt Express parcels use enabled universal providers. There is no dedicated adapter.

Flyt Express is 飞特物流 (Guangzhou Flyt Logistics), a Guangzhou cross-border forwarder whose site
is flytexpress.com. It runs lines to the Americas and Europe and hands many parcels to posts,
whose numbers it then shows.

## Numbers

Shoppers have posted 16-character numbers that begin with A or F, but Flyt's tracker returns no history
for either public sample. The corpus keeps them in quarantine and no rule names Flyt Express.

## Why there is no adapter

The [HTTPS tracking form](https://www.flytexpress.com/Home/LogisticsTracking) accepts a list of
numbers and a picture verification code. Its `/Home/GetTrackingInformation` reply gives both
shopper samples and an unknown number the same placeholder scan with a year-one timestamp.
A successful response therefore does not establish that Flyt holds the parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
