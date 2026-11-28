# 4PX

The public tracking site sends an anonymous JSON request to its tracking API.
The adapter selects the exact requested parcel and keeps its newest-first scan
order. Multi-package orders require separate parcel histories and fall back to
the providers.

Cainiao-style `LP` references ending in `CN` suggest 4PX without selecting it.
Its own numbers typed with `4XP` in front of the thirteen digits and `CN` are 4PX's, the
P and the X swapped: `four-px-swapped` names 4PX and the adapter asks with `4PX`.
The thirteen digits close with a GS1 check digit, which both rules ask for.
Emile's barcodes of `EM`, sixteen digits and `CA`, on parcels 4PX hands to Emile in Canada,
suggest 4PX ahead of [Emile](../emile/README.md): Emile's history names 4PX as the shipper,
and 4PX's feed holds the whole journey where Emile's holds the Canadian leg, so recognition
settles on 4PX when both know the number. Emile's twelve-digit barcodes stay Emile's.
References of `CN`, a six-digit date and eight digits are ones 4PX's tracker answers. The shape is
generic, so `four-px-dated` only suggests 4PX and recognition asks it.
HTTP recognition uses the same identity-bound feed to confirm matching shipment activity.

The portal displays each scan's `tkDateStr` with `tkTimezone`, an offset or,
for some partners' scans, a zone name. The adapter uses that pair because
`tkDate` carries different clock digits. A scan without a zone, or with a zone
name the clock database does not know, is retained as `local_time`, without an
invented instant. Four exceptions take the offset of 4PX's own facility scans.
"Order information has been transmitted to …": 4PX sends the partner the order
data when its facility measures the parcel and keeps the facility's clock for
it, but labels it with the partner's zone. So does its wait at the origin facility
for the line haul ("Waiting for pick up", `FPX_O_NM`), seconds after the measurement. "Returned from overseas", 4PX's
record that a returned parcel is back in the country it left, comes without a
zone; on the destination's clock it would read hours after the reply listing it. On some lines 4PX
writes its own milestones, to the minute, on the facility's clock under the destination's zone,
even its departure from the origin airport and its pickups in Hong Kong: on a parcel to Saudi
Arabia the last-mile pickup and the line haul read hours after the replies that first listed
them. When the departure or a row placed in Hong Kong or China carries a zone other than the
facility's, 4PX's minute-stamped rows under that zone take the facility's offset; a partner's scan
with its seconds keeps its own. On lines whose departure keeps the facility's zone, an arrival
under the destination's zone reads on the destination's clock. On a parcel to France, 4PX's
copies of La Poste's arrival and transit (arrived at destination, handled by
local carrier, transport to delivery centre, stamped to the second) carry La
Poste's UTC digits under Paris's offset, two hours before La Poste's own scans,
so they are read as UTC. 4PX's own transport rows, to the minute, and its copies
of the delivery round show Paris's clock. Parcels to France's overseas
departments and territories or to Monaco keep the stated offset: no 4PX copy
there has been compared with La Poste's own scans. Asendia Hong Kong's label and
manifest carry Asendia's UTC digits, as Yanwen relays them, under the
destination's offset: a label made as 4PX's facility measures the parcel reads
two hours before the measurement, at the same seconds. They are read as UTC.
4PX can list a partner's scan twice, on the partner's clock and with UTC digits under
the same offset, the offset earlier at the same seconds: a partner's order made as the
facility measures the parcel reads one second after the measurement in the first, and
hours before the pickup in the second. The copy whose digits are its twin's UTC time is
left out; a scan without such a twin keeps its offset.

Event codes map to stages. `FPX_O_IR` and `FPX_O_IRI` relay whatever step a
partner reported, from a label to an arrival abroad, so their wording decides.
"Parcel arrival notified" is Helthjem's notice that the shop announced the parcel, a
label rather than an arrival.
A partner's transit scans relayed without a code are staged by their whole
wording. A partner's "In transit" under the delivery code `FPX_D_SD` is a move
toward the office that delivers, days before the round, so it reads as in
transit. Other unknown codes stay unstaged. A partner's qualifier left after an
underscore at the end of a wording, as DPD's (`…_nabn`), is dropped. A
partner's pickup-shop record relayed in place of a wording (the shop's fields,
then `_store_type;pudo_id;pudo_name;…`) is no scan: its shop name and town are
the pickup point.
A US partner's postcode that 4PX writes twice at the end of a place
(`…,CA,90058 90058`) is kept once.

The server reference can identify a delivery partner's tracking number. Shared
result normalization keeps only a USPS routing barcode's package number, never
the ZIP code before it.
The contact card names the last-mile provider and its website; the adapter
reports the catalog carrier both agree on, never the card's phone numbers, and
provider discovery confirms the operator separately. The feed also answers
partners' numbers, 4PX's `OLS` references and its twelve-digit waybills. Twelve
digits are shared by many carriers, so detection suggests 4PX only for the waybills
starting 311 that parcels in the app showed 4PX's own tracker answering, first even when
FedEx's or SF Express's check digit also passes, and recognition asks 4PX first for them.
The range moves on as 4PX issues waybills. It also follows the Cainiao Express `DOFR…HD` numbers of parcels 4PX hands to
Cainiao Express in France, from the first mile; Cainiao answers them only once Cainiao
Express has the parcel, without 4PX's leg. Aggregators name 4PX "4PX Express" for those, and
that name is an alias, so their naming leads to this adapter, which still has to find the parcel.

Run `npm run test:carriers:live -- carriers/four-px`.
Set `FOUR_PX_TRACKING_NUMBER` outside the repository to check a real parcel.
