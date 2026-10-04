# SpeedPAK

Tracks Orange Connex SpeedPAK cross-border shipments through the public website's anonymous JSON endpoint.

## How it works

1. `direct`: POST one number and the English locale to the website's tracking service. The returned waybill must match the requested number before any history is retained.

The carrier provides epoch timestamps for scans, so cross-border events keep their instants without imposing a China timezone. Labelled last-mile references are retained for handoff discovery; an explicit UniUni label identifies that partner. Conflicting references do not select a partner.

## Limitations

Only SpeedPAK identifiers are accepted. Recipient postcodes are discarded. An unknown status remains unmapped, and a missing scan timestamp stays unresolved.

## Testing

`SPEEDPAK_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/speedpak`
