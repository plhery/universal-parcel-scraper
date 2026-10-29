# Xinghe Freight

Xinghe Freight parcels use enabled universal providers. There is no dedicated adapter.

Xinghe Freight is 星和货运 (广州星和货运代理有限公司, Guangzhou Xinghe Freight Forwarding), a
Guangzhou forwarder whose site is xinghe-express.cn. Universal providers name it GZXH.

## Numbers

No public source shows a whole Xinghe Freight number. A parcel a universal provider files under
GZXH has `GZXH`, ten digits and `YQ`, the layout of forwarders on the Hualei (华磊) platform, which
open their waybills with their own code; the corpus holds a made-up number in that shape. One
parcel is not enough for a high rule, so the rule stays low.

## Tracker

The site's tracking form opens `trackIndex.htm?documentCode=` on the Hualei tracker at
`134.175.243.207:8082`, over plain HTTP. That is [GZYL's](../gzyl/README.md) tenant, so a
dedicated adapter can use the shared Hualei client with GZYL's host.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
