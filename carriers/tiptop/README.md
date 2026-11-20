# TipTop

TipTop parcels use enabled universal providers. There is no dedicated adapter.

TipTop is the trading name of 义乌壹皓国际物流有限公司, a Yiwu company running cross-border
small-parcel lines, overseas warehouses and freight forwarding. Its site is tiptop56.com.

## Numbers

TipTop publishes no number format. One tracker's TipTop page shows an example, kept in
`numbers.json`; one sample does not make a rule, so detection offers no carrier for it.

## Why there is no adapter

Its site is built on ChinaParcels' site template, and the tracking box posts the number to
`chinaparcels.com/track-trace`, ChinaParcels' universal tracker behind a Cloudflare check, rather
than to a tracker of TipTop's own. No other public tracking surface names TipTop.

## Links

No address on its site opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
