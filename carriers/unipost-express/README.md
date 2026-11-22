# Unipost-Express

Tracks Unipost-Express, Unipost-Expres SRL of Chișinău, a Moldovan private express postal
operator that carries documents and parcels in Chișinău and across Moldova and sends international
ones through partner express services, through the tracking form on its site.

## How it works

`direct` posts the waybill to `https://www.unipost.md/ru/track/{number}` as the home page's form
does, with no session, captcha or account. The reply names the waybill after the form's fixed
`373` label, which must be the whole number asked, then lists the history newest first; a notice
that the waybill does not exist, naming the number, is one Unipost does not know. A request that
fails to reach the server gets one `retry` in the rest of the budget.

Rows give an English status, a place written as a three-letter city code and a country (`LED/RU`),
and a clock with no zone, kept as the row's wall clock. Every row shows the destination's code,
the first scans included, so only the delivery takes it as its place, written `LED, RU` so the
code can be placed. A row at midnight keeps its day alone: the page writes that clock for rows
it dates by their day. The recipient's line gives the destination's country, and the page the
weight. The sender's and recipient's names and the rows' comments, which name who signed, are
never read.

## Limitations

The waybill is the digits after the form's `373` label; `373-` before them is dropped. Seven
digits, the shape public waybills take, fit other carriers' numbers, so the carrier is never
detected and needs explicit selection. Rows before the delivery have no place of their own.

## Links

The form posts the waybill, and a plain GET of the page it posts to is the site's 404, so no
address opens one shipment.

## Testing

`UNIPOST_EXPRESS_TRACKING_NUMBER=… UNIPOST_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/unipost-express`
