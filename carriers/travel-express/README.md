# Travel & Express

Travel & Express parcels use enabled universal providers. There is no dedicated adapter.

Travel & Express (Παγκύπρια Εταιρεία Μεταφορών Δεμάτων Λτδ) is a Cypriot parcel courier founded by
intercity taxi firms, with stores in the island's towns and its own vans and motorcycles. It holds a
general postal authorisation from Cyprus's regulator, OCECPR.

## Numbers

Its tracker takes an air waybill or a prepaid voucher number. No public page shows a whole number
or its layout, so there is no rule.

## Why there is no adapter

The courier site's tracker (`travelexpresscourier.com/track.html`) posts the number to its own
handler and sends a number it does not know to the newer portal, which takes the number in `awb`.
The portal shows the shipment's status, its branch scans and its delivery. With no public number to
check its replies against, there is no adapter.

## Links

`portal.travelexpress.com.cy/system/?page=track&awb=<number>` opens one shipment.
The portal hides its own number field and asks visitors to sign in, so the catalog names no
search page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
