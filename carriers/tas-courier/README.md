# TAS Courier

TAS Courier E.E. is an Athens courier founded in 2002. It delivers in Attica with its own network
and hands the rest of Greece to partner couriers. Its site is tascourier.gr. The adapter reads a
voucher's status and history from TAS Courier's own voucher search.

## Numbers

A voucher is a V and its digits, written `V-` and the digits on TAS Courier's messages and pages. The search
finds a voucher only with its V. No detection rule names the shape: TAS Courier does not document it,
so a voucher is tracked with TAS Courier chosen.

## Retrieval

The tracking page at `/track` runs a reCAPTCHA before it reads the voucher, but the voucher search of
Pegasus Hermes, the courier software behind the site, answers without one. Its page,
`/pegasus/courier04/search00.php?pcode=SEARCHVOUCHER&r18p01=V-<digits>`, opens a PHP session, and in
that session `/pegasus/courier04/result.php?add_event=1&r18p01=V-<digits>&having=1` returns the list
the page loads into itself: a row for the voucher, then its statuses, oldest first, each with its
time and day. Without the session the list's address returns the site's page, which reads as an
inconclusive answer, never as not found. The row must name the whole voucher asked.

The statuses carry Athens wall clocks without an offset, so they stay wall clocks. A voucher the
search does not find gets the column headings alone, the same answer as a voucher written without its
V, so the adapter reads it as inconclusive (`portal_not_found`), not as not found.

The row also shows the partner's voucher when another courier delivers, the recipient's first name,
the person who delivered and the delivery's day and time. None is read: the partner's voucher does
not say which courier issued it, so it cannot hand the parcel over, and the others are personal or
repeat the delivery status. An estimated delivery slot is named in `unread_estimates` when a reply
fills it.

Other Pegasus Hermes tenants answer the same voucher search, among them Skyex Bioex and Kanga
Services; their columns differ.

## Links

The tracking page fills its field from the `v` parameter and looks the voucher up.

## Testing

```sh
npm run test:carriers:live -- carriers/tas-courier
```

`TAS_COURIER_TRACKING_NUMBER` replaces the public sample; `TAS_COURIER_UNKNOWN_NUMBER` names a voucher
the search does not find.
