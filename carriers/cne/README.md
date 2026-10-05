# CNE Express

Direct tracking for CNE cross-border shipments. Select CNE explicitly or use its official tracking link.

## Retrieval

One anonymous request to the public website API. Its WebAssembly signing reduces to MD5 with a public client prefix and the website's timestamp inputs, so retrieval does not need browser execution. The parser requires a matching source tracking number and nonempty movement history.

## Limitations

A number's unverified shape does not select CNE automatically. Unqualified cross-border clocks remain provider text; scan locations alone do not prove which clock the backend uses. Merchant and transfer references are not treated as verified delivery handoffs. Rejections and empty replies do not establish parcel absence.

## Testing

`CNE_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/cne`
