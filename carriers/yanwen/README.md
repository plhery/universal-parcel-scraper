# Yanwen

The adapter signs the anonymous tracking form with the MD5 convention embedded
in the public browser script, then submits it through HTTP. The fixed browser
salt is public protocol data; no account credential, cookies or browser session
are needed.

The English result contains desktop and mobile copies. The adapter binds both
to the requested number, requires them to agree, and reads the actual dated
timeline rather than the progress rail. Each scan carries its own GMT offset.
The external link opens the official form.

The newest scan decides the status when the map knows its wording; the LM40
icon marks the delivery scan whatever the last-mile carrier wrote. Otherwise
the category on the identity field, which the page's status filter labels,
gives the status. In transit names no stage, because it spans customs and the
partners' legs, and a delivery still needs a delivered scan.

Some relayed histories come twice: once on the local wall clock and once on
the UTC wall clock under the same offset, so their US scans read hours late. A
scan repeated with the same wording, icon and offset exactly that offset away,
in the same place or with one place missing, is the UTC copy: the adapter drops
it and the local scan keeps its place. Repeats at other intervals stay, as does
a scan that could pair with more than one other. A scan that arrived only as
its UTC copy cannot be told apart and keeps that clock. The app scan-identity
policy lets a stored scan gain its place this way without showing twice.

The parcel summary provides the last-mile reference. The notes name its
distributor and site; that carrier becomes `delivery_carrier` when the catalog
knows it and its own detection offers the reference. Contact numbers and the
customer's order number are not read. Scan locations keep the town and region
without Canadian postcodes or US ZIP codes, and relayed wording drops GOFO's
PIN and door-number fragments.

Run `npm run test:carriers:live -- carriers/yanwen`.
Set `YANWEN_TRACKING_NUMBER` outside the repository to check a real parcel.
