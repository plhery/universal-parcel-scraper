# Correos Panamá

Correos Panamá, Correos y Telégrafos Nacionales de Panamá, is Panama's national post.

## Numbers

Correos Panamá gives letters, parcels and EMS items UPU S10 numbers ending in `PA`. Generic postal
detection keeps these numbers, and a code ending `PA` with a valid check digit only suggests
Correos Panamá, which recognition asks first. The tracker also
holds mail other posts send to Panama, under their own S10 codes, so the adapter takes any S10
code with a valid check digit.

## Retrieval

The tracker is the UPU's IPS Web Tracking page. One plain GET of `IPSWeb_item_events.aspx`
with the code in `itemid` returns the item's scans, oldest first, with no cookie, token or
captcha. A code it holds nothing for gets the page's notice, which is not found. The page must
name the code asked.

Its own scans have Spanish event names, its other scans and the destination post's the UPU's
English ones; the adapter reads both, with La Poste Burkina Faso's map for the English names.

## Clocks

The page heads its clocks "Local Date and Time", month first on a twelve-hour clock. A scan in
Panama gets Panama's offset, UTC-5 all year; a scan abroad keeps its wall clock.

## Limitations

The next office is a plan, not a scan, and who signed is dropped; the extra information keeps
only a failed delivery's reason and what happens next.

## Links

The tracker opens `IPSWeb_item_events.aspx?itemid=<number>`, and the library reads the number
from that address.

## Testing

```sh
CORREOS_PANAMA_TRACKING_NUMBER=<public sample> CORREOS_PANAMA_UNKNOWN_NUMBER=RR999999995PA \
  npm run test:carriers:live -- carriers/correos-panama
```
