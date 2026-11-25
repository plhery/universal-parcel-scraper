# 4A Express

4A Express Ltd ("4A Express WorldWide") is a courier with offices in Nicosia, Limassol, Larnaca and
Greece, for local and international express items. It holds a general postal authorisation from
OCECPR.

## Numbers

Its [questions page](https://4aexpress.com/%cf%83%cf%85%cf%87%ce%bd%ce%ad%cf%82-%ce%b5%cf%81%cf%89%cf%84%ce%ae%cf%83%ce%b5%ce%b9%cf%82/)
says an air waybill has twelve digits. Many carriers use that shape, so there is no rule and
preflight never asks it.

## Retrieval

The tracker at `cms.4aexpress.com/Query/TrackAwbNoQuery.aspx` (Sagar Informatics courier software)
posts `{"AWBNo": <number>}` as JSON to its page method `TrackAwbNoQuery.aspx/ShowAwbNoQuery`, with no
session, key or CAPTCHA. The reply carries an HTML grid with the waybill number, its booking date,
origin and destination, and the history, newest first: each row's station, activity and time.

- The grid must name the number asked.
- A row's time is the station's wall clock without an offset, in Greece or Cyprus, and is kept as
  `local_time`.
- The delivery summary's "Received By" name, its delivery date and the booking date are not read.
- A number the tracker holds nothing under gets an empty grid, which does not say no shipment
  exists, so it stays open rather than not found. A block page is a challenge, and any other reply
  is a changed one.
- The tracker also takes several numbers split by commas; the adapter sends one.

## Links

The tracker looks numbers up in place, so no address opens one shipment.

## Testing

`npm run test:carriers:live -- carriers/4a-express`

The live test tracks the sample in `numbers.json` and checks the empty answer;
`FOUR_A_EXPRESS_TRACKING_NUMBER` tracks another number, and `FOUR_A_EXPRESS_UNKNOWN_NUMBER`
another unknown one.
