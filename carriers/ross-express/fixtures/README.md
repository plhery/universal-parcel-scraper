# Fixtures

`delivered.xml` is the reply `tracking.carrierlogistics.com/scripts/rxic.pol/protracexml.htm`
gives without a login for the public sample in [`numbers.json`](../numbers.json): the PRO, the
references, the shipper's and consignee's towns, ZIP codes and terminals, the pieces and weight,
the delivery's clock and status line with the signer, the lifecycle and the history newest first.
The bill and purchase order numbers and the signer's name are replaced by placeholders, and the
shipper's postal code is cut to its first three characters.

`not-found.xml` is the error document the trace gives for an invented PRO.
