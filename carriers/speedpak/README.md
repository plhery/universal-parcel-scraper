# SpeedPAK

Tracks Orange Connex SpeedPAK cross-border shipments through the public website's anonymous JSON endpoint.

## How it works

1. `direct`: POST one number and the English locale to the website's tracking service. The returned waybill must match the requested number before any history is retained.

The carrier provides epoch timestamps for scans, so cross-border events keep their instants without imposing a China timezone.

Each scan is classified by its English wording, else by SpeedPAK's own Chinese label (`eventDescCn`). The label stays in SpeedPAK's vocabulary when the English text is the last-mile carrier's own wording, such as USPS's upper-case scans.

Labelled last-mile references, in English or Chinese, are retained for handoff discovery. A USPS routing barcode opens with the recipient's ZIP code, so the hand-off line, the status summary and the reference keep only the package identifier after it (`wording.ts`); the identity policy in `identity.ts` lets a line stored with the barcode take the trimmed wording. The named carrier is reported when the catalog knows it and its detection offers the reference. Conflicting references do not select a partner. `delivered_at` is the newest scan's time when it is a delivery.

## Limitations

Only SpeedPAK identifiers are accepted; `EX` numbers seen in archives are not, and the tracker answers not found for them. Older numbers expire within months. Recipient postcodes are discarded. An unknown status remains unmapped, and a missing scan timestamp stays unresolved.

## Testing

`SPEEDPAK_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/speedpak`
