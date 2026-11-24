# CTL Group

Tracks the waybills of CTL Group, the Polish courier from Radzyń Podlaski that carries
car parts, engines and other bulky items, on its own tracker.

## How it works

1. `direct`: one GET of `https://www.ctlgroup.pl/tracking/<number>`. The server renders the
   lookup into the page, as it does after the tracking form's post, and needs no session or
   form token. The page puts the number in its search box, which the parser checks, and lists
   the scans in a table. An unknown number gets the notice "Brak zamówienia z podanym numerem
   listu przewozowego" with HTTP 200.
2. `retry`: one more GET when the first fails to reach the tracker or hangs.

## Notes

- The number is the waybill number printed under the label's barcode, all digits. The help
  pages show eight digits, and other courier networks use the same shape, so detection
  does not offer CTL Group: select it, or paste a tracking page link.
- The table gives each scan's wall clock without an offset, so events keep `local_time`.
- The page loads reCAPTCHA for a separate form, so the word "captcha" alone does not mark
  a bot check.
- Under a delivered shipment the page names the person who took it. The parser does not read it.

## Limitations

- The driver's name and phone and the expected pickup and delivery dates appear only after
  the sender's or recipient's postcode or the recipient's phone and a reCAPTCHA. They are
  not retrieved.

## Testing

`CTL_GROUP_PL_TRACKING_NUMBER=… CTL_GROUP_PL_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/ctl-group-pl`
