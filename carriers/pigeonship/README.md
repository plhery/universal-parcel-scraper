# PigeonShip

Tracks PigeonShip orders by their tracking number.

PigeonShip is a final-mile courier in the United States and Canada, at pigeonship.com. A
recipient's link opens `admin.pigeonship.com/shipping/tracking/package/<number>/`.

## How it works

`direct` reads that page with no session, token or browser. The server renders the order into the
page's script: its status code and label, a delivered flag, a due time with its offset, the
recipient's name, the map's points and the other stops on the driver's route. Only the code, the
label, the flag and the due time are read, after the page's "Tracking number" line matches the
requested number.

The page shows "Delivered" for code 64 and "In transit" for every other code, so only the codes
seen are staged and an unseen one leaves the stage unknown. The flag or code 64 makes a delivery.
The due time becomes the estimate until then.

Once the delivery is complete, the site serves another page at the order's path: "Your delivery
has been completed successfully." and a link to the delivery's pictures, without the order's
data or its number. That line is read as a delivery. The page names no number, but the site
serves it only at a delivered order's path and its "Page not found" at any other.

The page has no scan history, so an answer is a summary without events. Its ready-for-pickup time
is not read: it falls at midnight UTC, so it is likely a calendar day rather than a clock.

## Numbers

An order the app tracked has a digit, a letter, a digit, a letter, three digits, a letter, three
digits, a letter, two digits, a letter, a digit and two letters. A low rule offers PigeonShip for
that layout and recognition asks the page. The tracker takes any number of eight to thirty letters
and digits from a link.

An unknown number gets the site's "Page not found" page with HTTP 404, which is read as a missing
order. Any other 404, a redirect or a page without the order is never read as one.

## Testing

`PIGEONSHIP_TRACKING_NUMBER=<number> npm run test:carriers:live -- carriers/pigeonship`
