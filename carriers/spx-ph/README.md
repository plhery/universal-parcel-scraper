# SPX Express Philippines

Tracks Philippine SPX Express and Shopee Express single-parcel IDs. Other SPX countries have their own portals and are outside this adapter's scope.

The `direct` step reads the public Philippine order endpoint. After an inconclusive reply, `legacy` reads the older public feed with the timestamp checksum used by the current website. Neither request requires account cookies.

Both replies must identify the requested parcel. Actual scans establish progress; future progress-rail milestones are ignored. Freight parent orders are inconclusive because one delivered child cannot complete the whole order. Empty replies do not establish parcel absence.

Live test: `SPX_PH_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/spx-ph`.
