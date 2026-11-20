# The Delivery Group

The adapter reads the anonymous DocketHub shipment POST with an optional delivery postcode.
The empty reply can also mean that a known parcel needs its postcode, so it stays inconclusive. A reply must name TDG as carrier,
bind the whole requested reference or its returned alias, and identify one consistent item.
Branding the shared portal with `style=TDG` alone does not establish ownership. Multi-item
replies remain inconclusive so a sibling's delivery cannot complete the requested parcel.

Native item milestones include TDG handling and its delivery partner's scans. An explicit
partner delay stays a delay instead of becoming the relay's generic delivery-attempt notice.
Unsupported milestones leave provider fallback available.

Minute scan clocks remain local and offset-free. The SDK can infer a summary zone from the
catalog; item scans state no zone. Aggregate progress timestamps do not replace item clocks.
Contacts, proof-of-delivery images, coordinates, linked shipments and free relay notes are omitted.

The existing DocketHub link opens its guest form. No number rule is added for references shared
with other issuers.

Run live tests with `THE_DELIVERY_GROUP_NUMBER` and its `THE_DELIVERY_GROUP_POSTCODE` outside Git and
`npm run test:carriers:live -- carriers/the-delivery-group/adapter.live.test.ts`.
