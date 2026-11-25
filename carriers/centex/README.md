# CENTEX

Tracks parcels of CENTEX (忠进), a Shenzhen line that flies parcels to Brazil and posts them with
Correios, which delivers them. Its site is baxida.cn.

## How it works

1. `direct`: one GET of the tracker's list page, `www.baxida.cn/default/index/track?trackNos=<number>`,
   the page the site's tracking form posts to. No session, account or image code is needed: the form on
   `get-track-detail` asks for an image code only for its own POST.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The page lists each shipment it finds by any of three numbers, the Correios number, CENTEX's waybill
and the customer's reference, with a hidden table of its scans in English and in Chinese, which hold
the same rows. The adapter reads the shipment whose row names the requested number. An unknown
number leaves one empty row; any other page is never read as a missing parcel.

## Notes

- The adapter takes CENTEX's waybills, ZJ and seventeen digits, and the Correios numbers the line
  gives parcels for Brazil. Customer references are not taken: the tracker matches them loosely.
  Recognition asks only about the waybills, since the Correios number belongs to Correios.
- Asked by the waybill, the Correios number is the delivery number, with Correios as the delivering
  carrier.
- Scans state no offset: the China rows are on China's clock, the Correios rows on Brazil's, so each
  keeps its wall clock.
- Correios records the posting, "objeto postado", after the flight from Shenzhen has left, so it
  reads as transit.

## Limitations

The tracker can keep only the latest scan of an old parcel. No weight, delivery estimate or proof of
delivery.

## Testing

`npm run test:carriers:live -- carriers/centex`, with `CENTEX_TRACKING_NUMBER` and optionally
`CENTEX_UNKNOWN_NUMBER` set outside the repository.
