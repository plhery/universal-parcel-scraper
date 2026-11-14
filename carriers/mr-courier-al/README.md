# Mr. Courier

Mr. Courier parcels use enabled universal providers. There is no dedicated adapter.

Mr. Courier, Mr. Courier Shpk of Tirana, is an Albanian courier, transport and warehousing
company that delivers documents and parcels within Albania.

## Numbers

A comment in the tracking page's script gives one code, `MR` and six digits, as an example. One
example does not prove the layout, and six digits are too few to tell it from other carriers'
numbers, so there is no rule. The example and its source are in [`numbers.json`](numbers.json).

## Why there is no adapter

The tracking page posts the code as JSON in a form field to a web service on the company's back
office, which returns the status history. With no number known to be live, its replies cannot be
checked, so there is no adapter.

## Leads

`POST https://backoffice.mrcourier.al/webservice.php?operation=GetTracking` with the form field
`element` holding `{"data":{"Method":"GetTracking","Params":{"Code":"{number}"}}}`.

## Links

Its tracker takes codes only through the page's script, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
