# YTO Express

Tracks Chinese domestic waybills, and YTO Global waybills (YTG and twelve digits) once YTO's
overseas centres scan them, through the official website's consumer feed.

## How it works

1. `direct`: one anonymous JSON POST returns an identity-bound scan list. The website
   displays a slider before querying; the feed accepts reads without cookies or a
   challenge token. The adapter uses each scan's operation code and preserves the
   feed's newest-first order.
2. `retry`: a read that fails to reach the site, or hangs, runs once more within the
   budget, on www.ytoexpress.com, YTO's other domain for the same site. The first read
   gets half of the budget. An HTTP status or a reply is never sent again.

www.yto.net.cn resolves to a CDN edge that changes every minute, and some edges take no
connection from abroad, so a retry on the same name meets the same dead edge.
www.ytoexpress.com, under YTO's own certificate, serves the same feed from YTO's addresses.

## Notes

Domestic scan clocks use China time. Invalid dates remain unresolved. Return dispatch
keeps subsequent movement, collection and signature scans on the return to the sender.
Return transit remains active; only a completed sender signature is terminal.
Short operation labels and depot names are retained; expanded descriptions containing
courier contacts, recipient details and collection addresses are excluded.
The feed can send a scan with its code and description but no label or depot. Such a scan
takes the label the website gives its code, and an arrival or departure takes the first
place its description names unless that bracket gives a contact. A code without a label
of its own stays malformed.
Known labels are shown in English, and rows stored with the Chinese label take the
English in place.

An overseas centre's scan on a YTO Global waybill has a code of words, such as `DEBUS`, no
label, and a description that names the centre before the label ("<centre>,已收入"). The
scan takes that label and the centre as its place. A code of words the adapter does not
know keeps no stage; without that form, its description's clauses before a contact are its
label. Its clock is China time: Cainiao's copy of the same scan, with its stated offset,
gives the same instant to the second.

Relayed Chinese labels and their ParcelsApp translations use the same vocabulary as
direct scans. ParcelsApp's UTC-labelled China clocks are read in the catalog timezone.
17TRACK relays the expanded description instead; its copy keeps the clauses before the
first that names the courier, a phone or YTO's hotline, without a bracket that gives one,
and a row that opens with a contact is left out.

## Limitations

An echoed number with no scans, as YTO answers for a waybill not scanned yet, is no history
(`NoHistoryError`): inconclusive, not a failure of the lookup. It has no `listed` reason: the feed
echoes a number YTO never issued the same way. Archived histories, and a YTO Global
shipment's legs before an overseas centre scans it, use separate website flows and are
outside this adapter's scope.

## Testing

Set `YTO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/yto/adapter.live.test.ts`.
