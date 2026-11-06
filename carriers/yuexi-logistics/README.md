# YXL Logistics

YXL Logistics parcels use enabled universal providers. There is no dedicated adapter.

YXL Logistics, 悦希国际物流, is a forwarder in Shenzhen. Its logo reads YXL; its site text and the
tracking services write YXI or YXIL, which are aliases. It ships goods by sea, land and air from
China to Hong Kong, Indonesia, Malaysia, the Philippines, Singapore, Thailand and Vietnam, with
warehousing and consolidation for overseas Chinese and students. Its site is yxlg.com.

## Numbers

No public page shows one of its numbers, so there is no rule.

## Why there is no adapter

Its tracking page reads the number from its `no` parameter and posts it, with the company's
code, to `tms.yxlg.com/ord/order/guest/pod`, which answers JSON. No public number is known to see
a found reply.

## Links

`www.yxlg.com/track.html?no=<number>` opens one shipment: the home page's search builds it. Its
former domain, yxilogistics.com, serves an older site over HTTP only, as its HTTPS certificate
names yxlg.com, so no link rule reads it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
