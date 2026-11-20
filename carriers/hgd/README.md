# HGD International

HGD International (恒广达国际, Hengguangda (Shenzhen) Supply Chain Technology) runs postal and
dedicated small-parcel lines for online sellers from Shenzhen to other countries. Tracked through
its own tracking server, a Neoman GInfo system, whose waybills on its dedicated lines begin with HGD.

## How it works

1. `direct`: one `GET http://139.196.154.164/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line,
   then the waybill's summary in `EMS_INFO` and its rows, oldest first, in `TRACK_DATA`.
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- The tracking form on 365igo.com.cn posts to the same server's `EmmisTrack` page, which renders
  the same record as HTML. The adapter reads the record itself. The server and the site answer
  only plain HTTP, so the catalog links neither.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other
  code but `100` is inconclusive, and a non-200 reply is a moved route.
- `TRCKING_NBR` must be the whole number asked: a request without a number gets some other
  waybill back.

## Notes

- Rows state no zone. They keep their wall clocks, and a row dated after the lookup on Shenzhen's
  clock is left out.
- On both samples the rows after the warehouse exit come at the same offsets from it.
- The two Chinese warehouse wordings are in [`statuses.json`](statuses.json); the English rows go
  through the shared wording rules.
- The destination is named in Chinese, as `英国`, and read as an ISO code; the weight is kept.
  The sender's address and the forwarder's inner number are not.

## Limitations

- No delivery estimate. The record gives no delivering carrier or onward number.

## Numbers

The public samples are HGD, two letters, ten digits and YQ, a layout Hualei forwarders share. Two
samples are too few to tell its series from theirs, so no rule claims it and the adapter answers
explicit selection. The samples and their source are in [`numbers.json`](numbers.json).

## Testing

`HGD_TRACKING_NUMBER=… HGD_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/hgd`
