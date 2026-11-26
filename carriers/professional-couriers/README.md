# The Professional Couriers

Tracks The Professional Couriers (TPC), a domestic courier network in India, through the
consignment search on its own site.

## How it works

`direct` follows the steps the home page's search takes, in one ASP.NET session:

1. It posts the consignment number from the home page's form. A number TPC does not take comes
   back as the page's "InValid Consignment No." alert.
2. The search moves to a captcha page. The shared text model in
   `core/transport/text-captcha-worker.mjs` reads the picture's five letters and digits, and the
   adapter posts the reading. A wrong reading comes back as "Invalid Captcha" with a new picture,
   and the adapter tries again, up to three pictures. A reading that is not five letters or
   digits is not sent.
3. The tracking page shows a one-line status. "We are sorry! Your consignment status request
   could not be processed" is TPC's answer for a consignment it has no status for: a number it
   never booked, and one whose records it no longer keeps.
4. The page's details button asks for a four-digit code, and the page prints the code for every
   visitor. The adapter reads it from the page and posts it, so no code lives in the adapter.
   When the page stops printing one, the lookup fails as a challenge.

The details list dated scans on station wall clocks, newest first. A scan's "From" names the
station that sent the consignment on, so a "Received at" scan is placed at the station it names,
before the hyphen that adds its branch; other scans are placed at their "From" station. The
phrase a scan opens with, such as "Bag Despatched to" or "Out for Delivery", is kept as its code.

TPC's site answers from the production host and from India, and timed out from some European
networks.

## Numbers

Customers quote consignment numbers made of the booking station's three-letter code and eight
or nine digits. Three letters and nine digits is also the shape Purolator's rule claims, and
three letters and eight digits is printed by other carriers too; the station codes vary, so no
rule claims either layout and the carrier needs explicit selection.

## Limitations

The origin, destination, delivery date and acknowledgement in the details header are left out.
Consignee and proof-of-delivery details are only given by the booking station.

## Links

No public address that opens one consignment is known, so no link is read.

## Testing

`PROFESSIONAL_COURIERS_TRACKING_NUMBER=… PROFESSIONAL_COURIERS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/professional-couriers`
