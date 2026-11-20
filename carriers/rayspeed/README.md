# RaySpeed Asia

Select RaySpeed Asia to track a cross-border air waybill. The public tracker issues a
guest session and a form token. The adapter uses them for a single waybill lookup and
checks both the result key and the waybill on each scan.

Scans keep the carrier's local date and clock. Day-only notices keep their precision,
and the adapter leaves the proof-of-delivery attachments outside the result.

Waybills are RAY and thirteen digits, which rule `rayspeed-1` suggests RaySpeed Asia for.

Set `RAYSPEED_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/rayspeed`.
