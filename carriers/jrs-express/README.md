# JRS Express

JRS Express, run by JRS Business Corporation in Pasig City, carries parcels and documents between
its branches across the Philippines, delivering them or releasing them at the destination
branch's counter.

## Numbers

A shipment is identified by the airbill number on its official receipt together with the branch
code (BC) printed beside it, three or four digits. The tracker takes the two in one field, the
airbill first and the branch code after a hyphen, and needs both. Airbills and branch codes vary
in length, so the digits alone do not say where the airbill ends, and a wrong split asks for
another shipment's reference, which the tracker answers in full. `carrierTrackingNumber` keeps a
JRS Express reference's hyphen, for JRS Express alone, and the adapter refuses a reference without
it before asking. Neither part is distinctive, so there is no detection rule: select JRS Express
or open its tracking link. The samples and their sources are in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://jrs-core-api.azurewebsites.net/api/Tracking/v1/track-airbill?airbill={airbill}-{branch}`,
   the request the tracking page's script makes. It needs no session, key, cookie or browser.
2. `retry`: a read that fails to reach the API, or hangs, is sent once more within the budget. The
   first try gets half of it.

The API answers a JSON list of scans, oldest first. Each names its airbill (`trackingID`) and
branch code (`trackingCode`), which must be the ones asked; the tracker ignores leading zeros in
either, so the comparison does too. A scan has a status text, a time, the branch with its town
(`branchLocation`), and the receiver, relationship and remarks. The adapter keeps the status text,
the time and the branch. The receiver, who on a release is the person the parcel went to, the
relationship and the remarks, which the page does not show, are not read. A row without a status
text, as the page's own example reference holds, is no scan.

An empty list is the tracker's answer for a reference it holds nothing for, including another
branch code for the same airbill, and reads as not found: the reply answers that request alone.
A browser check or a 403 is a challenge, a redirect, 404 or 410 a moved API, a 429 a rate limit,
and a page or any other reply shape a changed reply.

There is no recognition: no detection rule offers JRS Express for a number, so preflight never
asks it.

## Clocks

The page drops a trailing `Z`, reads the clock in the browser's zone and adds eight hours. Scan
times written with `Z` are UTC, so it shows them on Manila's clock, and the adapter keeps their
instants. A release's time comes with `+00:00`, which the browser applies before the eight hours
are added: in the Philippines the page shows it sixteen hours after its digits. That reading puts
the public sample's release in the afternoon after its branch received the parcel, where its digits
as an instant, or as a Manila wall clock, would come before the receipt. The adapter keeps the
page's reading as the scan's `local_time` and lists the scans in the page's order.

## Limitations

- No delivery estimate, weight, service, sender, recipient address or proof of delivery.
- Only releases at the branch have been seen with `+00:00`; a door delivery's or a return's time
  has not.
- Status texts the map does not hold keep their wording and are staged by the shared wording rules
  where they can be.

## Links

The library reads a reference from the `or` query parameter of `/track` on `jrs-express.com` and
`www.jrs-express.com`, the address the tracking page opens with.

## Testing

```sh
JRS_EXPRESS_UNKNOWN_NUMBER=<made-up airbill-branch reference> \
  npm run test:carriers:live -- carriers/jrs-express
```

`JRS_EXPRESS_TRACKING_NUMBER` replaces the public sample.
