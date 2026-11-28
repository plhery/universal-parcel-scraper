# World Package

World Package (World Package Logistics Limited) is a British cross-border e-commerce carrier. It ships online
shops' parcels from the United Kingdom to the United States, Europe and Asia, wines and spirits among them, and
hands them to local couriers and posts for the last leg. Its site is worldpackage.co.uk. Select the carrier
explicitly.

## How it works

1. `direct`: one `POST https://wpl-uk.couriernavigator-secure.com/json/search/trackingdownload` with the
   number as `consign_note`, the search its Courier Navigator tracking page makes, without a login, cookie,
   CAPTCHA or browser.

The tracker runs on Courier Navigator, as [UBX UK's](../ubx-uk/README.md) does, and the adapter shares its
reader and status ids: the job must carry the number asked, an empty job list is read as not found, events
keep their wall clocks and are staged by their status id.

## Notes

- World Package's page shows the job's timeline and, for some jobs, flight legs from a separate link, which is
  not read. It shows no forwarding reference; when the reply carries one, the adapter hands it on as UBX UK's
  does.

## Limitations

- No found reply has been seen, so the fixtures are synthetic, shaped as the page's scripts read the reply.

## Numbers

Its tracker looks up World Package's own air waybill or job numbers. The last-mile carrier's number on a parcel
belongs to that carrier. No public page shows a World Package number, so there is no rule.

## Links

The tracking page opens numbers from its `consign_note` parameter, on its Courier Navigator host. The portal
page on worldpackage.co.uk frames the same tracker but does not load it, so links go to that host.

## Testing

Set `WORLD_PACKAGE_TRACKING_NUMBER` and optionally `WORLD_PACKAGE_UNKNOWN_NUMBER` outside the repository and
run `npm run test:carriers:live -- carriers/world-package`.
