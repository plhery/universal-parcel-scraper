# Feibao Logistics

Tracks Feibao Logistics (飞豹快运, formerly 中铁飞豹快运), a less-than-truckload network with hubs
across China, through the goods tracking page on its site.

## How it works

The tracking page at `http://www.fb56.com/GoodsTrace/indexNew` posts the form `code=&word=<waybill>`
to `http://www.fb56.com/GoodsTrace/GetOrderAjax2`. The page carries a slider captcha, but its script
skips it while `checkType` is `'0'`, and sends an empty code. `direct` sends the same request with no
session, captcha or account. The site answers over HTTP only. A request that fails to reach the
server gets one `retry` in the rest of the budget. A bare `1`, which the script reads as a wrong
captcha code, is a challenge.

The reply holds one track for the waybill, whose rows must all name it; an unknown waybill comes
back with no track. Each row has a status number, its station, the next station and an instant as
`/Date(ms)/`. The adapter words a row as the page's script does: arrived at, sent from one station to
the next, out for delivery, signed for or refused. The station is the location, except on a
signature row, whose station column holds the masked signatory and is left out, as are the driver
and the driver's phone. Rows of other bill types, which the page hides, are skipped. The reply also
carries the recipient, the sender and the goods, which the adapter does not read.

## Limitations

Waybills are F and eleven digits, or twelve digits, shapes other carriers share, so the carrier is
never detected and needs explicit selection.

## Testing

`FEIBAO_LOGISTICS_TRACKING_NUMBER=… FEIBAO_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/feibao-logistics`
