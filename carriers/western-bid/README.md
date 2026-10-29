# Western Bid

Western Bid parcels use enabled universal providers. There is no dedicated adapter.

Western Bid (WestParcel) is a Ukrainian cross-border consolidator: it collects parcels in Kyiv and
Poland, ships them to its Florida warehouse or abroad, and hands them to UPS, USPS, DHL eCommerce,
FedEx, DPD or Nova Global for delivery. Its sites are westernbid.com and westparcel.com.

## Numbers

Its own numbers start with `WBX`, as its Etsy guides say; the one seen on its tracker has twelve
digits after it. The rule is low confidence, from that one number. Parcels it hands on also carry
the delivering carrier's number, which its tracker answers too; those carriers' rules cover them.

## Why there is no adapter

Its tracker's lookup needs an invisible reCAPTCHA Enterprise token, so only a browser can ask it.

## Links

The tracker on track.westparcel.com and track.westernbid.com opens a number from its
`trackNumber` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
