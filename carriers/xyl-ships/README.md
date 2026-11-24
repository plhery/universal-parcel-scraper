# XYL-Ships

XYL-Ships is a Chinese forwarder whose site is xylships.com. 17TRACK lists it as FXYL, the name
the catalog keeps as an alias. 17TRACK's XYL is another company, Xingyuan International Logistics,
which the catalog files as [XYL](../xyl/README.md).

## Retrieval

The site's tracker renders in the browser from a JSON service on another host. `direct` asks it
the same way, `GET https://siking-track.com/api/tracking/?transfer_no=<number>&documentCode=<number>`,
with no session, account or verification. `retry` repeats only a network failure within the lookup
budget.

The reply must name the requested number as its `transfer_no`. Each scan states its time with an
offset (`+08:00`), so events carry instants. The scans arrive newest first; their `order` field is
the order's id, not a position. The sender's and recipient's addresses and the customer reference
in the same reply are never read.

`code: -1` with "未找到对应的物流订单" (no matching logistics order) is not-found. Any other
non-zero code is inconclusive.

## Numbers

XYL-Ships publishes no number format and no public page shows one of its numbers. Numbers made
of NUDE, ten digits and EX are its own: 17TRACK files their histories under FXYL, and no other
carrier's rule takes the shape, so the rule has high confidence. Numbers of XLWL, ten digits and
EX or EXP have the same layout, and XYL-Ships's tracker answers them with whole histories, so a
second high rule takes them. Numbers of FXLP, ten digits and DH get the same answers from its
tracker, and 17TRACK files them under FXYL, so a third high rule takes them. The corpus holds
synthetic ones.

## Limitations

The tracker shows no expected delivery. The last mile's own scans arrive as XYL-Ships's English
wordings, without the delivering carrier's name or number.

## Testing

`XYL_SHIPS_TRACKING_NUMBER=<number> XYL_SHIPS_UNKNOWN_NUMBER=<number> npm run test:carriers:live -- carriers/xyl-ships`
