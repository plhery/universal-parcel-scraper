# Zhongzhou Logistics

Zhongzhou Logistics parcels use enabled universal providers. There is no dedicated adapter.

Zhongzhou Logistics (莆田市中洲物流供应链有限公司, Putian Zhongzhou Logistics Supply Chain) is a
Putian cross-border forwarder whose site is zhongzhouwuliu.com.
[ParcelsApp](https://parcelsapp.com/en/carriers/zzwl-cn) lists it as ZZWL.

## Numbers

No public source shows a whole Zhongzhou number, so there is no detection rule. Parcels reach it
through a universal provider's carrier name.

## Why there is no adapter

The site's tracking link opens its tenant of the rtb56 platform,
`http://msgyl.rtb56.com/track_query.aspx`, which [YWBZ](../ywbz/README.md) and
[YDH](../ydh/README.md) also use. An adapter needs a public number that tracker answers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
