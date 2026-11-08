# MAKESEND

MAKESEND parcels use enabled universal providers. There is no dedicated adapter.

MAKESEND is the brand of Makesend Express Co., Ltd. in Bangkok. It delivers parcels the same day
in Bangkok and nearby provinces with its own riders and vehicles, including chilled parcels and
cash on delivery. Its site is makesend.asia.

## Numbers

The site's form example shows MS and digits, and the tracker takes up to 32 characters. No public
page shows a real number, so there is no rule.

## Why there is no adapter

Its tracker at app.makesend.asia posts the number to `api-merchant.makesend.asia/api/msa/tracking`
with signed headers that the page first fetches from `app.makesend.asia/api/generateAPIHeader`.
No public number is known to see a found reply.

## Links

`app.makesend.asia/tracking?t=<number>` opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
