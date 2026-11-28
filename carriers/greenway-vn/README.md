# Greenway

Greenway, run by Công ty TNHH Đức Thành GR in Hanoi, ships online sellers' parcels from Vietnam to
the United States, where USPS delivers them, with a customer portal and an API. Its site is
greenwayvn.com.

## How it works

`direct` posts the code to the logs lookup behind the tracking page,
`api.greenwayvn.com/v1/packages/logs`, as `{"codes": [...]}`: no session, token or browser. The
lookup runs on [The Human Express](../the-human-express/README.md)'s platform, whose reader, in
that folder, reads the reply; this folder holds Greenway's statuses and host.

The reader keeps the package whose code is the whole code asked, with its logs on UTC clocks. The
package's status gives the stage unless the newest staged log is further along, and an alert that
the package was sent back gives `returned`. Greenway's page shows the package's last-mile number;
it becomes the delivery number, with USPS as the delivery carrier when its rules take the number.
A delivered package's delivery clock is kept when set: the platform writes an unset clock as the
year 1.

## Numbers

Its API documentation gives package codes as G and sixteen digits, made of the customer's id and the
package's id, and adds SB in its webhook example. The examples are made-up orders that the tracker
does not hold, so they are negative samples. Colis Privé's `colis-prive-1` reads most codes of G and
sixteen digits, so there is no rule. Parcels also carry a USPS number, which the USPS rules read.

## Limitations

HTTP 400 with "Không tìm thấy" is not found, as the tracking page reads it; any other refusal, or a
reply that is not JSON, is a failure. No found reply has been seen, so the reader follows the fields
the tracking page's script reads and the examples of the API documentation.

## Links

Tracking links carry the code as `code` on the tracking page.

## Testing

`GREENWAY_VN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/greenway-vn`
