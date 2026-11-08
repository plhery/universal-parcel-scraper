# Meitetsu NX Unyu

Meitetsu NX Unyu parcels use enabled universal providers. There is no dedicated adapter.

Meitetsu NX Unyu (名鉄NX運輸), formerly Meitetsu Unyu (名鉄運輸) or Meitetsu Transportation, is the
Nagoya Railroad group's less-than-truckload carrier in Japan. Its regional group companies share
its tracker. Its site is meitetsuunyu.co.jp.

## Numbers

The tracker takes waybill numbers (お問合せ伝票番号) of up to 15 digits. The format is not
published and no public page shows one, so there is no rule.

## Why there is no adapter

Its tracker on ap.meitetsuunyu.co.jp is an ASP.NET form that posts up to ten waybill numbers with
the page's view state and needs JavaScript. The page gives its service hours as 7:00 to 24:00 on
weekdays and Saturdays and 7:00 to 21:00 on Sundays and holidays, Japan time. A second lookup on
the same page needs a customer number and password. No public number is known to see a found
reply.

## Links

The tracker posts its form, so no address opens one parcel. The site policy refuses framing and
links from sites that link to it to draw business.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
