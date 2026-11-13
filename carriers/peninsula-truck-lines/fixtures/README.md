# Fixtures

Replies of `api/track/public/{PRO}`, the guest lookup Peninsula's tracking page makes, shaped
after the page's code and Peninsula's tracking API guide. The log lists the oldest row first,
as the guide's example does.

`delivered` goes from the pickup to the delivery manifest, repeats one row, and dates its
delivery only in its status line, which names the person who received it. It carries the
shipper, the consignee, a bill of lading, a purchase order and the terminals. `in-transit` is
on its way between terminals with an empty status line. `not-found` is the answer for a PRO the
lookup does not have, as the service gives it.

Numbers, names, references, places and clocks are invented.
