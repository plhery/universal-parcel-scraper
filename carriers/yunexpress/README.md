# YunExpress

The adapter loads the official Yuntrack page and captures its tracking API
response. Plain HTTP is rejected by the site's request protection even with the
current public browser signature. The browser creates the request signature and
anonymous authorization header itself; the adapter retains no session material.
The local browser keeps ordinary resource loading because intercepted network
requests are rejected by the site's protection.

Configure a Chromium executable for local browser capture. When no local
executable is configured, the adapter can use a Trawl browser service that
includes the [Yuntrack capture hook](../../trawl/tracking-capture.mjs).
The hook checks the posted parcel and reads the browser's decoded API body.
Stock Trawl skips compressed bodies. Service capture is skipped when local
Chromium is configured.
An interactive verification remains a challenge and falls back to the providers.

The response's latest-event record supplies an offset for that exact scan.
Earlier scans often contain only local wall clocks, retained as `local_time`
in portal order. Storage timezone fields never supply scan offsets. The
reply is inconclusive when its latest summary does not match the first scan.
A shorter projection than the returned raw history is incomplete. An older row
with a place but no wording is skipped.

The downstream reference is retained for separate carrier confirmation. The
page's notes link to the last-mile carrier's site; that carrier becomes
`delivery_carrier` when the catalog knows the host and its own detection offers
the reference, because one brand's host can also serve regional networks the
catalog carrier does not cover. The feed relays the last-mile carrier's wording
without codes, so the status map also holds the partner lines seen there.

The reply carries a weight without a unit and with placeholder values for some
services, and estimate fields the page never shows, so neither is read. The
customer's order number is never read.

Run `npm run test:carriers:live -- carriers/yunexpress` with a
configured browser. Set `YUNEXPRESS_TRACKING_NUMBER` outside the repository to
check a real parcel.
