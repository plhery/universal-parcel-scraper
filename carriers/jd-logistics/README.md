# JD Logistics

Tracks international waybills through the official international website's anonymous feed.
Chinese domestic waybills use a separate service and can fall back to enabled universal providers.
Detection still selects JD Logistics for them: JD followed by thirteen characters, of which at
most the first two are letters, as in the JDV and JDX series.

## How it works

One JSON POST queries the website's international tracking proxy. The parent reference must
match the requested number and contain one waybill with dated scans. Multiple pieces are
rejected because selecting one could return another parcel's progress.

Each scan keeps its operation code as its provider code and takes its stage from it
(`status.ts`); a scan with an unknown code is classified by its wording. The newest scan
decides the status. The courier's name and phone are dropped from the out-for-delivery wording
(`wording.ts`).

## Limitations

An empty answer is inconclusive outside the international service. Scan clocks without an
explicit offset remain local; the request's display timezone does not establish a scan's zone.
The epoch time and zone each scan also carries are not read. Proof-of-delivery images and
recipient verification are excluded. Chinese domestic waybills answer an empty list here.

## Testing

Set `JD_LOGISTICS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/jd-logistics/adapter.live.test.ts`.
