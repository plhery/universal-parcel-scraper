# APM Logistics

PT APM Logistics, of Padang, is an Indonesian cargo company that ships goods across Indonesia by
road, sea and air. Tracked through the waybill tracker on its website.

## How it works

1. `trawl`: the browser service opens the tracker page for the waybill,
   `apmlogistics.id/cek-resi?resi=<waybill>`. The page gets its own reCAPTCHA v3 token and posts
   it with the waybill to `POST /api/proxy.php?ep=trace`. The service's
   [helper](../../trawl/apm-logistics-browser.mjs) captures that post alone and passes on the
   checkpoints and delivery status without names, addresses, phones, rates or staff.

- The tracker checks the token: without one, or with one reCAPTCHA scores too low, it answers
  `Google Captcha Error`. The helper then reloads the page once for a new token; a second refusal
  is a challenge.
- A waybill the tracker does not know answers `Shipment tidak ditemukan`, which is not found.
  Another refusal is inconclusive.
- The reply and each checkpoint must name the waybill asked.

## Notes

- Checkpoints are staged by their wording. The tracker shows the handover to a partner,
  `PAKET DITERIMA VENDOR` or `FC`, as `PAKET DITERUSKAN KE KOTA TUJUAN`, the parcel going on to
  its destination city, and the adapter words it the same way.
- A delivery status the tracker's script reads as delivered, `TERKIRIM` or `DELIVERED`, becomes
  an event on its day and time at the destination city. Another delivery status is kept without
  a stage.
- Checkpoint times are wall clocks without a zone, and APM Logistics' branches span Indonesia's
  zones, so they stay in `local_time`.
- A checkpoint is placed at the town the reply gives for it, or else at its branch.

## Limitations

- No sender, recipient, signatory or proof of delivery. The waybill's date, weight, pieces,
  reference and districts of origin and destination are not read.

## Numbers

A waybill is ten digits, as the example the tracker's form prints. The adapter takes nothing
else. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`apmlogistics.id/cek-resi?resi=<waybill>` opens one waybill, and the library reads the waybill
from that address.

## Testing

```sh
FLARESOLVERR_URL=http://127.0.0.1:8191 npx vitest run --config vitest.carriers-live.config.ts carriers/apm-logistics/adapter.live.test.ts
```

The live test tracks a public sample in `numbers.json` through the browser service at
`FLARESOLVERR_URL`; `APM_LOGISTICS_TRACKING_NUMBER` tracks another waybill, and
`APM_LOGISTICS_UNKNOWN_NUMBER` checks the not-found answer.
