# Landmark Global

Tracks individual LTN references through the official anonymous portal,
including the portal's canonical identity for references ending in N1.

## How it works

One bounded GET retrieves the complete server-rendered event table. The canonical parcel
identity must match, and the latest summary must agree with the first scan: its clock always,
its wording when it shows one. Before the first scan has wording, and once a parcel is sent
back, the summary shows only the stage or a link to the return's own tracking.
Multi-parcel pages are rejected. An exact absence message is accepted only when
the requested reference is retained in the page's search field.

## Notes

Scans retain their local clocks and provider order. The page supplies one
current server offset for browser display, which does not establish historical
DST offsets. No instant or delivery timestamp is inferred from it or the scan's
country. The host archives unresolved clocks and asks providers for dated
progress.

The page relays the delivery partner's scans in the partner's own wording. Landmark's
wording sets the stage first, then the shared rules, for the parcel as for each scan. A
summary that reads "Returned" and links to the return's tracking makes the parcel returned,
since its own history stops before the return. The return's reference is not read.

The delivery partner's reference is its tracking link's text, kept when unambiguous. The
partner's name names the carrier unless its link is on another carrier's site; when the name
is not a catalog name, the link alone names it. A generic "Postal Carrier"
names none: its number is an international postal item that the destination's post
delivers. Of the ship-to place, only the country is read. Order references, package
references and payment actions are excluded.
Deposit permission alone does not establish delivery; only a completion scan does.

## Live test

Set `LANDMARK_GLOBAL_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/landmark-global/adapter.live.test.ts`.
Optionally set `LANDMARK_GLOBAL_UNKNOWN_NUMBER` to check explicit absence.
Set `LANDMARK_GLOBAL_ALIAS_NUMBER` to check an N1 reference against its canonical parcel.
