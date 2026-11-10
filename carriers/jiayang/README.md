# Jiayang International

Jiayang International (嘉扬国际, 东莞市嘉扬国际物流有限公司) is a Dongguan forwarder with lines from
China to the Gulf states, the United States and South Africa. Its site is jygjgyl.com. Tracked
through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.jygjgyl.com/index/tracknumber/getTrackingByNos?nos={number}`,
   as the tracking page `index/tracknumber/track?nos={number}` sends it on load. It needs no
   cookie, key, CAPTCHA or browser.
2. `retry`: one more request after a network failure or a timeout. The first gets half of the
   budget.

- The tracker is [CTTYEX's](../cttyex/README.md) system, as [Dongdu's](../dongdu/README.md) and
  [Liuchen's](../liuchen/README.md) are, and the adapter reads its reply with CTTYEX's parser: a
  JSON array with an item per number asked, holding the summary's status and the countries in
  Chinese and the scans in English, newest first. The item must echo the whole number in capitals.
- The lookup sends that array as a JSON string, which the page parses a second time. The adapter
  reads either form.
- The system answers an unknown number with HTTP 200, the status "查询不到" and no scans. Only that
  answer is not found. A redirect or a 404 is a moved route, a browser check in place of the reply
  is a challenge, and any other reply that is not the expected JSON is a schema failure.

## Notes

- The scans run from the order data through the flight and import clearance to the last-mile
  network in the United States, in the system's words, and CTTYEX's map stages them. The rows
  there open with the town, state and ZIP code, and the clearance with the port's town: the town
  becomes the location and the ZIP code is dropped.
- Every row is a wall clock on Beijing time, the rows abroad too; a universal provider relaying
  the tracker gives the same instants.
- Universal providers name the carrier JIAYANG.

## Limitations

The tracker answers for parcels of the last two months. An older one reads as not found, which
leaves the enabled universal providers to answer.

## Numbers

A parcel the app tracked was numbered `JYGJ`, the initials of 嘉扬国际, ten digits and `YQ`. A
universal provider reported it from JIAYANG and Jiayang's tracker answered it. With that one
parcel and no public number, the rule offering Jiayang for that layout is low, and recognition
asks the tracker about it. The adapter takes any number of eight or more letters and digits:
other numbers reach it when they are filed under Jiayang or opened from its tracking link.

## Links

The tracker opens numbers from its `nos` parameter.

## Testing

`npm run test:carriers:live -- carriers/jiayang`, with `JIAYANG_TRACKING_NUMBER` and optionally
`JIAYANG_UNKNOWN_NUMBER` set outside the repository.
