# Jifan

Jifan parcels use enabled universal providers. There is no dedicated adapter.

Jifan is 吉凡国际物流 (深圳市吉凡国际物流有限公司, Shenzhen Jifan International Logistics), a
Shenzhen cross-border forwarder whose site is szjf56.cn. Universal providers name it Jifan.

## Numbers

Its numbers are `JFGJ`, the company's initials, nine digits and `CN`. A lookup on Jifan's own
tracker, archived by the Wayback Machine, shows a parcel's history under such a number, and no other
carrier's rule takes the layout, so `jifan-1` has high confidence. The archived number's ninth digit
is the S10 check digit of the eight before it, but a parcel a universal provider files under Jifan
fails that check, so the rule checks no digit.

## Tracker

The tracking page asks `GET https://www.szjf56.cn/index/tracknumber/getTrackingByNos?nos=` without a
cookie, key or CAPTCHA. The reply is a JSON string holding a list with an entry per number: its
status, countries and timeline rows of a time and a text. A number the tracker does not know comes
back with the status `查询不到` and no rows. Its rows are the wording of the Hualei (华磊) forwarder
platform, with Chinese wall clocks.

## Links

The tracking page writes the number in `?nos=` into its query box.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
