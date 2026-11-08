# Navata Road Transport

Navata Road Transport parcels use enabled universal providers. There is no dedicated adapter.

Navata Road Transport is a road carrier based in Vijayawada, Andhra Pradesh. It carries parcels,
part loads and full truckloads across India through its branches and franchises. Its site is
navata.com.

## Numbers

The tracking form's example shows a waybill as one letter and six digits. That shape fits many
carriers, and no public page shows a real waybill, so there is no rule.

## Why there is no adapter

A lookup needs the waybill number and its booking date. The tracking page reads both from
`online.navata.com/SENDMAIL/wbtrackjson.jsp`, which answers JSON, and does not search on a
waybill number alone.

## Links

The tracking page opens a waybill only when the address also carries its booking date, so no
address opens one parcel from its number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
