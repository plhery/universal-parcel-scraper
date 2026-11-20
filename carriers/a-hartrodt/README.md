# a. hartrodt

Track a house air waybill or forwarding bill of lading in a. hartrodt's public
[Tracking & Tracing form](https://ttsecure.hartrodt.com/pserv/tt/open?sep=1).
The adapter submits the reference in the HAWB/FBL field. It uses the job number
field for the carrier's three-letter, sixteen-digit job references.

The search returns a job list. The adapter follows only a matching row on the
carrier's own host and checks the reference again in the shipment details
before reading the dated messages. The messages include GMT offsets, which
the adapter keeps in the timestamps. The route's ETA concerns the vessel
or flight, so it is excluded from the delivery estimate.

The [public U.S. import record for a. hartrodt Nederland](https://www.importinfo.com/a-hartrodt-nederland-b-v)
lists house bill `SHPT2608285747` on 21 September 2026. The carrier confirmed
the Rotterdam–Norfolk job and returned its dated export and import milestones
on 20 November 2026. The fixtures retain the matching search and event tables
and the actual response for a separate publicly listed house bill that the
tracker could not find.

Select **a. hartrodt** explicitly.
