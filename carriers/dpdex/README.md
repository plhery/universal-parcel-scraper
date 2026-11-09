# DpdEx

DpdEx parcels use enabled universal providers. There is no dedicated adapter.

DpdEx (多普达国际, Shenzhen Duopuda Smart Logistics) is a Shenzhen forwarder with air parcel lines
from China to Europe for cross-border e-commerce. Its site is duopudaexpress.com. It is not part of
DPD.

## Numbers

A parcel the app tracked was numbered `DPE` and eleven digits. ParcelsApp named DpdEx for it, with
its pickup, export and flight scans, beside iMile, which delivered it in Italy. With that one
parcel and no public number, the rule offering DpdEx for that layout is low confidence.

## Why there is no adapter

Its tracker, `track_query.aspx` on client.duopudaexpress.com, serves over plain HTTP only and is an
ASP.NET form that can ask for a CAPTCHA. It takes no number from its address, so the catalog sends
people to the home page, which serves over HTTPS.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
