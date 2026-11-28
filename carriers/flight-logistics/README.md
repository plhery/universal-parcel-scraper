# Flight Logistics

Flight Logistics (Flight Logistics Group Ltd) is a third-party logistics provider at Heathrow and
Wokingham in the United Kingdom, with eCommerce fulfilment, courier and freight services and art
shipping. Its site is flightlg.com. Select the carrier explicitly.

## How it works

1. `direct`: one `POST https://flightlg.couriernavigator-secure.com/json/search/trackingdownload` with the
   airway bill or job number as `consign_note`, the search the MyFlight page on flightlg.com makes, without a
   login, cookie, CAPTCHA or browser.

The tracker runs on Courier Navigator, as [UBX UK's](../ubx-uk/README.md) does, and the adapter shares its
reader and status ids: the job must carry the number asked, an empty job list is read as not found, events
keep their wall clocks and are staged by their status id, and a job handed to another network hands on its
forwarding reference.

## Limitations

- No found reply has been seen, so the fixtures are synthetic, shaped as the page's scripts read the reply.

## Numbers

Flight Logistics publishes no number format, and no public page shows one of its airway bill or
job numbers, so there is no rule.

## Links

The MyFlight page opens numbers from its `consign_note` parameter, with `method=tracking`. The
Courier Navigator host's own tracking page does not read the parameter.

## Testing

Set `FLIGHT_LOGISTICS_TRACKING_NUMBER` and optionally `FLIGHT_LOGISTICS_UNKNOWN_NUMBER` outside the
repository and run `npm run test:carriers:live -- carriers/flight-logistics`.
