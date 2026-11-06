# Dongdu Logistics

Dongdu (东渡供应链) is a Shenzhen forwarder shipping parcels from China to Latin America and
Canada. Its site is ddgyl.vip. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.ddgyl.vip/index/tracknumber/getTrackingByNos?nos={number}`,
   as the tracking page `index/tracknumber/track?nos={number}` sends it on load. It needs no
   cookie, key, CAPTCHA or browser.
2. `retry`: one more request after a network failure or a timeout. The first gets half of the
   budget.

- The tracker is [CTTYEX's](../cttyex/README.md) system, as [Liuchen's](../liuchen/README.md) and
  [Jifan's](../jifan/README.md) are, and the adapter reads its reply with CTTYEX's parser: a JSON
  array with an item per number asked, holding the summary's status and the countries in Chinese
  and the scans in English, newest first. The item must echo the whole number in capitals.
- An unknown number is HTTP 200 with the status "查询不到" and no scans. Only that answer is not
  found. A redirect or a 404 is a moved route, a browser check in place of the reply is a
  challenge, and any other reply that is not the expected JSON is a schema failure.
- Only `www.ddgyl.vip` answers; the bare domain does not.

## Notes

- The scans run from the order data through the flight and import clearance to the local
  partner's processing centre, in CTTYEX's words with a few of Dongdu's own, and CTTYEX's map
  stages them. Every row is a wall clock on Beijing time.
- Universal providers name the carrier DDGYL, the initials of 东渡供应链 and its domain.

## Numbers

A parcel the app tracked was numbered `DDGYL`, eight digits and `YQ`, the way its sister tenants
put their own initials first. A universal provider reported it from DDGYL and Dongdu's tracker
answered it. With that one parcel and no public number, the rule offering Dongdu for that layout
is low, and recognition asks the tracker about it. The adapter takes any number of eight or more
letters and digits: other numbers reach it when they are filed under Dongdu or opened from its
tracking link.

## Links

The tracker opens numbers from its `nos` parameter.

## Testing

`npm run test:carriers:live -- carriers/dongdu`, with `DONGDU_TRACKING_NUMBER` and optionally
`DONGDU_UNKNOWN_NUMBER` set outside the repository.
