# JD Logistics

Tracks international waybills through the official international website's anonymous feed.
Chinese domestic waybills use a separate service and can fall back to enabled universal providers.
Detection still selects JD Logistics for them: JD followed by thirteen characters, of which at
most the first two are letters, as in the JDV and JDX series.

## How it works

One JSON POST queries the website's international tracking proxy. The parent reference must
match the requested number and contain one waybill with dated scans. Multiple pieces are
rejected because selecting one could return another parcel's progress.

## Limitations

An empty answer is inconclusive outside the international service. Scan clocks without an
explicit offset remain local; the request's display timezone does not establish a scan's zone.
Proof-of-delivery images and recipient verification are excluded.

## Testing

Set `JD_LOGISTICS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/jd-logistics/adapter.live.test.ts`.
