# Hart2Hart Express

Hart2Hart Express is a UK courier and air cargo sales agent that also carries UK shoppers' parcels to Malta,
where Miles Express delivers them. Its site is hart2hartexpress.co.uk. Select the carrier explicitly.

## How it works

1. `direct`: one `POST https://harttohart.couriernavigator-secure.com/json/search/trackingdownload` with the
   number as `consign_note`, the search its tracking page makes, without a login, cookie, CAPTCHA or browser.

The tracker runs on Courier Navigator, as [UBX UK's](../ubx-uk/README.md) does, and the adapter shares its
reader and status ids: the job must carry the number asked, an empty job list is read as not found, events
keep their wall clocks and are staged by their status id.

## Notes

- The page shows the forwarding reference of a job passed on, without a link to its tracker. The adapter
  hands the reference on, and names the network only when the reply's link and the reference's shape agree.

## Limitations

- The public number in [numbers.json](numbers.json), from the old tracker, now gets an empty job list, so no
  found reply has been seen and the fixtures' found job is synthetic.

## Numbers

Its job numbers are nine digits starting with 8, as its Malta partner's support form states. TNT, XPO,
R+L Carriers and Cargus numbers share that shape, so there is no rule.

## Links

The tracker opens numbers from its `consign_note` parameter.

## Testing

Set `HART2HART_EXPRESS_TRACKING_NUMBER` and optionally `HART2HART_EXPRESS_UNKNOWN_NUMBER` outside the
repository and run `npm run test:carriers:live -- carriers/hart2hart-express`.
