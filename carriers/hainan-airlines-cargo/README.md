# Hainan Airlines Cargo

Hainan Airlines Cargo (HNA Cargo, 海航货运) carries Hainan Airlines' air freight. Its numbers are air
waybills: the airline's prefix 880 and an eight-digit serial.

## How it works

The tracking box on `www.hnacargo.com` posts the air waybill and a four-letter verify code to
`/Portal2/AwbSearch.aspx`, which renders the result on the server.

1. `direct`: one `GET /VerifyCode.aspx?s=tracking`, which opens the session the code is kept in.
   The shared text model reads the picture, and one `POST` of `hdAwbCode` (`880-` and the serial)
   and `hdVerifyCode` returns the page. A refused code shows an error notice; the adapter then
   takes a new picture, three in all.

- An air waybill the tracker knows gets a tab named after it, then tables of its route, goods and
  weights and of its scans. The adapter requires the tab to name the air waybill asked.
- An unknown air waybill leaves the tab empty and shows only the contact line, which reads as not
  found.
- The page is read in Chinese (`Language=zh-CN`), the language its operations are recorded in.

## Notes

- Some forwarders write the origin airport between the prefix and the serial (`880-PEK-…`). Detection
  names Hainan Airlines Cargo for that form and for the dashed air waybill; eleven bare digits are
  left to the carriers whose numbers share the shape. The adapter checks the serial's IATA check digit.
- Each scan's time is the station's wall clock with no zone, under the heading "local time". One
  history crosses several zones, so the clocks stay `local_time`.
- The location is the station's IATA code. The operation (`已制单` and the like) stages a scan and is
  its provider code; an operation without a record falls to the shared wording rules.
- The route, goods, weights, pieces and flights are not kept.

## Limitations

- No estimated arrival and no scan time as an instant. The page asks for contact for more detail
  than its scans.

## Testing

Set `HAINAN_AIRLINES_CARGO_TRACKING_NUMBER` (and `HAINAN_AIRLINES_CARGO_UNKNOWN_NUMBER` for the
not-found answer) outside the repository and run
`npm run test:carriers:live -- carriers/hainan-airlines-cargo`.
