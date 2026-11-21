# Fixtures

`form.html` is a synthetic copy of the home page's WebForms form, `Index.aspx`: its state, the
consignment number box with its Tracking button, the outlet search beside it and the pickup
request with its captcha. Its page state is invented.

The other files are whole replies of `Frm_DocTrack.aspx`, kept as served, for public samples in
`numbers.json` and for a made-up number. Each shows the number echoed, the booking detail (from
and to centers, day and clock, consignee) and the status line; the transit and delivery tables
follow, oldest first.

- `in-transit.html`: a consignment booked, sent through two regional offices and received at its
  destination office. Each office name is a link whose tooltip holds the office's address and
  phone numbers.
- `dispatched.html`: a consignment booked and sent from its regional office to its destination.
- `booked.html`: a number shown with its booking office and "Booked By" alone, without a day or
  scans.
- `contact.html`: a number shown with its booking office and an office to contact, with its
  address and phone numbers, in place of a status; the tables are left out.
- `not-found.html`: the reply for a made-up number: the number echoed, every field empty and both
  tables with their headers alone.
