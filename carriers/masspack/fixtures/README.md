`synthetic-order.json` is synthetic: no public page shows a Masspack order number. It follows the reply
model the AU-OPS tracker's own script reads (an order with `state`, `trackingNum`, `jobNum`, `notFound`,
`trackings` with `node`, `context` and `eventTime`, `subTrackings` with `trackingNum` and `carrier`, and
`headNodes`), with node and state codes from its translations, invented clocks, wordings and references,
and UPS's documented example number as the delivery carrier's.

`not-found.json` is the service's reply to an all-zero number it does not have.
