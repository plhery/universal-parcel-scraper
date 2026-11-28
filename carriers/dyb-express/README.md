# DYB Express

DYB Express (dybservice.com) ships parcels from its warehouses in Canada to China by air, clears them
through Chinese customs and hands them to a courier in China. Tracked through the tracking page its
site's form opens.

## How it works

1. `direct`: one `GET http://www.dybservice.com/order/track?no={number}`, the page the site's form
   opens. It needs no cookie, token, account or browser. The page shows the waybill, the courier in
   China and its number in read-only fields, then the rows in a `track-list`, newest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of
   the budget, so the retry fits in the rest.

- A single row 未查询到轨迹 is the page's answer for a number DYB has no waybill under. A page without
  one waybill field, a waybill other than the number asked, or a non-200 reply is a failure, never not
  found.

## Notes

- The site answers plain HTTP only, so the catalog gives Kuaidi100's page on DYB as its canary and
  links no portal.
- The page labels its rows 北京时间, so each row is read on Beijing time, the relayed courier's rows
  too. A row dated after the lookup keeps its wall clock alone.
- After customs the page relays the courier's rows in its words. `statuses.json` stages DYB's own rows
  and the rows ZTO and YTO send, with `…` for the places they name; another courier's rows are staged by
  the shared wording rules. The first bracket names the place.
- The relayed rows name couriers, collectors and signers with their phones, and give branch phones and
  hotlines. A name given with a phone, a bracket that gives a contact and a clause that names a person or
  gives a phone are left out; station and pickup point names stay.
- The courier in China and its number are kept when the page names a courier whose own rules offer that
  number.
- The page repeats some relayed rows; each is read once.

## Limitations

- No delivery estimate, weight, service, sender or recipient.

## Numbers

The public samples are Kuaidi100's test number, S and twelve digits, a shape other carriers'
references share, and the example on Kuaidi100's DYB page, DYB and thirteen digits. No detection rule
offers DYB and the adapter answers explicit selection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/dyb-express` tracks Kuaidi100's test number, or the number in
`DYB_EXPRESS_TRACKING_NUMBER`, and checks an invented number, or the one in
`DYB_EXPRESS_UNKNOWN_NUMBER`, reads as not found.
