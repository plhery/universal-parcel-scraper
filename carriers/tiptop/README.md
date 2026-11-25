# TipTop

TipTop parcels use enabled universal providers. There is no dedicated adapter.

TipTop is the trading name of 义乌壹皓国际物流有限公司, a Yiwu company running cross-border
small-parcel lines, overseas warehouses and freight forwarding. Its site is tiptop56.com.

## Numbers

Its tracking numbers read `YHC`, twelve digits and `CN`, as the example on a tracker's TipTop page
shows and as 17TRACK's TipTop service answers for one an app reader tracked. TipTop publishes no
format and no tracker of its own confirms the family, so the rule is low confidence: detection
offers TipTop for it, and the enabled universal providers answer.

## Why there is no adapter

Its site is built on ChinaParcels' site template, and the tracking box posts the number to
`chinaparcels.com/track-trace`, ChinaParcels' universal tracker behind a Cloudflare check, rather
than to a tracker of TipTop's own. ChinaParcels names no courier for a `YHC` number and lists no
TipTop service to choose. No other public tracking surface names TipTop.

## Links

No address on its site opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
