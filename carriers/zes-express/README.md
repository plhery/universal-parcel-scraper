# ZES Express

ZES Express parcels use enabled universal providers. There is no dedicated adapter.

ZES Express is the brand of Eshun International Logistics (俄顺国际物流), a Yiwu forwarder carrying
e-commerce parcels from China to Russia, where CDEK delivers them. Its site is zes-express.com.

## Numbers

Its numbers are `ZESZE`, ten digits and `YQ`, which `zes-express-1` suggests at low confidence;
two public pages quote one each. The CDEK waybill it hands a parcel on with stays with
[CDEK](../cdek/README.md).

## Why there is no adapter

Its tracker runs on the platform [YYpost's adapter](../yypost/rtb56.ts) reads, whose lookup
answers without a session; it answered public numbers. The tracker is served over plain HTTP from
a bare IP address and its page adds a slider CAPTCHA, so no portal link is published. An adapter
is possible and not yet written.

## Links

The tracker's page sits on a bare IP address, so no link is read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
