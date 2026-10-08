# CNE Express

Direct tracking for CNE cross-border shipments. Detection selects CNE for its `3A5V` numbers; for any other, select CNE explicitly or use its official tracking link.

## Retrieval

One anonymous request to the public website API. Its WebAssembly signing reduces to MD5 with a public client prefix and the website's timestamp inputs, so retrieval does not need browser execution. The parser requires a matching source tracking number and nonempty movement history. The echoed `Number_t` is either that number or, once CNE names the last-mile supplier, the transfer number the supplier tracks.

## Interpretation

CNE's own wordings map exactly. Partner rows are read by their label, the text before a full-width semicolon, because the explanation after it can announce a later step. A row no rule reads takes its CNE status code, as CNE's tracking page labels the codes; a partner's acceptance that CNE codes as shipping stays transit. A summary code other than shipping (delivered, returned, customs inspection, invalid address, lost, exception or destroyed) outranks the latest row, which can stop at the hand-off.

A named last-mile supplier declares the hand-off: its transfer number becomes the delivery tracking number, and DHL, Royal Mail, SpeedX and USPS are named as the delivery carrier. Without a named supplier, the transfer number can be a merchant's reference and is not followed; merchant references never are.

## Limitations

Only the `3A5V` family, which CNE's own tracking answers, selects CNE automatically. Unqualified cross-border clocks remain provider text; scan locations alone do not prove which clock the backend uses. The summary's delivery date has no zone either, so it gives no delivery time. Rejections and empty replies do not establish parcel absence.

## Testing

`CNE_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/cne`
