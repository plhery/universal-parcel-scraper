# Diamond Line Delivery Systems

Diamond Line Delivery Systems, from Meridian, Idaho, carries less-than-truckload freight in Idaho and the
neighbouring Northwest and Mountain states.

## How it works

`direct` posts the PRO number to the API behind the tracking page's widget, `www.dlds.com/wp-json/dlds/v1/tracking`,
as `{"type":"pro","number":…}`: no session, nonce or browser. The reply is the shipment and its history, newest
first, and is read only when the shipment's `pro_number` is the number asked.

The API answers a shipment with HTTP 500 and its JSON, and a number it does not hold with HTTP 404 and WordPress's
error object, code `tracking_not_found`, naming the number. Any other error object is a failure.

Each history row is a wording, a day, a time of day without a zone and the terminal or town. The terminals are in
the Pacific and Mountain zones, so each row keeps its wall clock. A row with a blank time, such as the proof of
delivery's, keeps its day alone. A row whose place reads `In Transit` names no place. The wordings are staged by
`statuses.json`; a departure names the terminal it heads to.

The record holds `SEE SCANNED POD` as the signatory when the proof of delivery is a scanned page, which is not a
person, so it is not kept. The weight is in pounds.

## Numbers

The tracker takes a PRO number. The one public example has nine digits, a shape many carriers share, so there is
no detection rule and the adapter has no recognition: a lookup asks Diamond Line only when the user picks it.

## Limitations

The API also keeps rate quotes, whose lifecycle is `Quote`, under numbers of the same shape; a quote is read as no
shipment. The shipment's origin, destination, ship date, pallet count and references, and the page's progress
rail, are not read. The history gives no delivery estimate.

## Links

The tracker takes the number only from its form, so no address opens one shipment.

## Testing

`DIAMOND_LINE_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/diamond-line`
