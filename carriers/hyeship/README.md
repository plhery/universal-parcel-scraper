# Hongyuan Express

Hongyuan Express (鸿远快递, 鸿远物流) forwards parcels from the United States to China: it takes them in at
its Los Angeles warehouse, sends them to China, clears them there and hands them to a domestic courier, whose
scans its tracker relays under its own name. Tracked through its own tracking server, a Neoman GInfo system
on hyeship.com, which HGD, SRJ and the other GInfo tenants also run.

## How it works

1. `direct`: one `GET https://www.hyeship.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`, in GBK. The reader is shared with HGD in
   [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site's tracking page at `/track/` asks the same server. Plain HTTP is redirected to HTTPS.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.

## Notes

- The warehouse's rows, up to customs, are dated by their day alone and stay dates. Its timed rows are on
  Pacific time, a row that names China is on China's clock, and the domestic courier's sentences, which
  begin with 到达 or 已签收, are on China's clock because that courier works only in China. A row that says
  neither keeps its wall clock alone.
- The domestic courier's sentences name the delivering courier with a mobile, the pickup point and who
  signed. The adapter leaves out the courier, the phones and the signer, keeps 已签收 alone for the
  signature, and keeps only the kind of a pickup point (寄存点, 驿站…), whose name can give the recipient's
  street or building. A pickup point's place is dropped for the same reason.
- `SIGN` holds who signed and is not kept. The destination country is kept; the origin, the piece count,
  the service name and the firm's inner number are not.

## Limitations

- The domestic courier is not named, so no delivery carrier is given.
- No delivery estimate, sender or recipient.

## Numbers

Kuaidi100's test number is in the UPU S10 layout, but its check digit does not hold, so postal detection
does not take it. Hongyuan Express's waybills have no published shape of their own, so no rule offers it; the
adapter answers explicit selection of any waybill of letters and digits. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/hyeship` tracks Kuaidi100's test number, or the waybill in
`HYESHIP_TRACKING_NUMBER`, and checks an invented waybill, or the one in `HYESHIP_UNKNOWN_NUMBER`, reads as
not found.
