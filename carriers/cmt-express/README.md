# CMT Express

CMT Express parcels use enabled universal providers. There is no dedicated adapter.

CMT Express (诚贸通供应链), run by Shenzhen Chengmaotong Supply Chain, resells DHL, FedEx, UPS, TNT and USPS
services and Guangzhou small-parcel lines from China. Its site is cmtexpress.com.cn.

## Numbers

Its waybills are CMT and twelve digits. A low rule offers CMT Express for that shape.

## Why there is no adapter

Its waybill query, `tms.cmtexpress.com.cn/trackIndex.htm`, is a page of a hosted forwarding system. It takes
up to 30 numbers in a form post without a login and answers with server-rendered HTML: the shipper's
reference, destination, latest status and recipient, then the scans. No adapter reads it yet.

## Links

Its waybill query looks numbers up in place, so no address names one.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
