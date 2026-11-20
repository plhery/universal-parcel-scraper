# Post Aruba

Select Post Aruba to read postal-item history from its IPS Web Tracking site. The adapter
requires the matching item number and reads the location and event for each scan.

The site shows office-local clocks in month/day/year order. It lists scans from oldest to
newest across postal partners. The adapter preserves those clocks and the carrier's order,
including scans from the destination post.

Set `ARUBA_POST_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/aruba-post`.
