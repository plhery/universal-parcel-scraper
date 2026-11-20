# Fixtures

Replies of the order page's server action for the two order references in
[`numbers.json`](../numbers.json), whose public M24 tracking links were archived
(<https://web.archive.org/web/20260507163942id_/https://lms.m24logistics.com/track-my-order/o2001531786>
and
<https://web.archive.org/web/20260408091616id_/https://lms.m24logistics.com/track-my-order//o1983692063>).
`delivered-courier-it.txt` goes through several missed rounds to delivery by Courier IT;
`delivered-dpd.txt` is a next-day delivery by DPD. `unknown-reference.html` is the HTTP 500 page
the tracker answers for a reference of the same shape that it holds no order for, without the
script its CDN adds.

Names, addresses, postcodes, phone numbers, delivery instructions and signees are removed.
