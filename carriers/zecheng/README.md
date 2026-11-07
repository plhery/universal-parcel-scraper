# Zecheng International Logistics

Zecheng (深圳市择诚国际物流有限公司) is a Shenzhen forwarder for cross-border e-commerce parcels.
Its site is zecwl.com. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api.zecwl.com/index/tracknumber/getTrackingByNos?nos={number}`,
   the request the tracking page `index/tracknumber/track?nos={number}` sends when its form is
   submitted. It needs no cookie, key, CAPTCHA or browser.
2. `retry`: one more request after a network failure or a timeout. The first gets half of the
   budget.

- The tracker is [CTTYEX's](../cttyex/README.md) system, as [Dongdu's](../dongdu/README.md) is,
  and the adapter reads its reply with CTTYEX's parser: a JSON array with an item per number
  asked, holding the summary's status and the countries in Chinese and the scans in English,
  newest first. The item must echo the whole number in capitals.
- A known number's array comes encoded once more, as a JSON string; an unknown number's comes as
  the array itself. The adapter decodes the string first.
- An unknown number is HTTP 200 with the status "查询不到" and no scans. Only that answer is not
  found. A redirect or a 404 is a moved route, a browser check in place of the reply is a
  challenge, and any other reply that is not the expected JSON is a schema failure.
- The tracker is on `api.zecwl.com`. The `www` host serves the company site with a certificate
  that does not verify.

## Notes

- Scans are in CTTYEX's words, and CTTYEX's map stages them. Every row is a wall clock on
  Beijing time.
- Universal providers name the carrier ZHECHENG.

## Numbers

A parcel the app tracked was numbered `ZCGJ`, ten digits and `CN`. A universal provider reported
it from ZHECHENG and Zecheng's tracker answered it. ZCGJ, the initials of 择诚国际, are also those
of a Zhengzhou forwarder, so with that one parcel and no public number the rule offering Zecheng
for that layout is low, and recognition asks the tracker about it. The adapter takes any number
of eight or more letters and digits: other numbers reach it when they are filed under Zecheng or
opened from its tracking link.

## Links

The tracker fills its form from its `nos` parameter.

## Testing

`npm run test:carriers:live -- carriers/zecheng`, with `ZECHENG_TRACKING_NUMBER` and optionally
`ZECHENG_UNKNOWN_NUMBER` set outside the repository.
