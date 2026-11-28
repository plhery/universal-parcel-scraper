# J&T Express Singapore

J&T Express Singapore parcels use enabled universal providers. There is no dedicated adapter.

This covers J&T Express's Singapore network, tracked on jtexpress.sg. J&T Express in China and the
Philippines prints JT and thirteen digits and stays with [J&T Express](../j-and-t/README.md) and
[J&T Express China](../j-and-t-cn/README.md).

## Numbers

Waybills are JT and fourteen digits, the shape the tracking page shows as its placeholder and
[EasyParcel's Singapore guide](https://blog.easyparcel.com/sg/understanding-tracking-number-formats-for-easyparcel-couriers/)
lists. No other carrier in the catalog issues it, so the rule is high.

## Why there is no adapter

The tracking page posts up to twenty waybills to `trackingList.do` with a Tencent slider CAPTCHA
ticket while its `captchaSwitch` flag is on, and refuses a request without one as a verification
code error. An unknown waybill comes back as an empty trace list that does not repeat the number,
so such a reply cannot be tied to the waybill asked for.

The J&T Singapore app tracks through `api.jtexpress.sg` only after the user signs in, and the
merchant tracking gateway needs merchant credentials. The support chat logs every lookup and is
not used.

## Links

No address opens a waybill's history; the tracking page takes the number in its form.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
