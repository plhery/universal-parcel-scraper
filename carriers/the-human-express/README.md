# The Human Express

The Human Express, run by The Human Company Limited in Hanoi, ships online sellers' parcels from
Vietnam to the United States, including TikTok Shop orders and stock for Amazon's warehouses, and
USPS delivers them there. Its site is thehuman.express.

## How it works

`direct` posts the code to the logs lookup behind the tracking page,
`api.thehuman.express/v1/shipment/packages/logs`, as `{"codes": [...]}`: no session, token or
browser. The reply lists `packages`, one per code it holds, and `logs`, each naming its package by
`package_id`. Only the package whose code is the whole code asked is read, with its logs.

[Greenway](../greenway-vn/README.md) runs its tracking page on the same platform, so the reader,
`packageLogs.ts`, serves both. `status.ts` builds each company's map from its `statuses.json`.

Each log is a wording, a place and a clock in UTC, read as an instant. The logs are staged by
`statuses.json`, else by the shared wording rules. The package's `status_string` is the tab the page
files it under; it gives the stage unless the newest staged log is further along, since the page
files a parcel accepted at the processing center as in transit. An alert that the warehouse or the
carrier sent the package back gives `returned`; a slow package's alert says nothing. The package's
`country_code` is the destination, and a `tracking` object with a last-mile number and carrier,
which Greenway's page shows, becomes the delivery number, with USPS as the delivery carrier when
its rules take the number.

## Numbers

Its API documentation gives package codes as THE and sixteen digits, made of the customer's id and
the package's id, often followed by SB. The examples are made-up orders that the tracker does not
hold, so they are negative samples. They share their digits with Greenway's, which runs on the same
platform, so `the-human-express-1` suggests The Human Express at low confidence. Parcels also carry
a USPS number, which the USPS rules read.

## Limitations

The code must be the package's own: a reply holding only other packages is a failure. HTTP 400 with
"Không tìm thấy" is not found; any other refusal, or a reply that is not JSON, is a failure. No
found reply has been seen, so the reader follows the fields the tracking page's script reads and
the examples of the API documentation.

## Links

Tracking links carry the code as `trackings` on the tracking page.

## Testing

`THE_HUMAN_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/the-human-express`
