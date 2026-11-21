# Shree Mahavir Express Services

Shree Mahavir Express Services is a domestic courier with regional offices in Ahmedabad,
Mumbai, Indore and other cities of western and central India. The adapter reads one twelve-digit
consignment number from the public tracker on its website, over plain HTTP.

## How it works

1. `direct`: three requests under one deadline, none with a cookie, captcha or browser.
   - `GET /Index.aspx` gives the home page's WebForms tracking form and its state.
   - `POST /Index.aspx` sends that state with the number as `txtAWBNo` and the Tracking button
     `cmdTrack`. The site answers with a redirect to `Frm_DocList.aspx?docnos=`, followed by the
     number encrypted into a Base64 key.
   - `GET /Frm_DocTrack.aspx?docno=` with that key gives the tracking detail: the number, the
     booking (from and to centers, day and clock, consignee), a status line, the transit rows and
     the delivery rows.
2. `retry`: the same three requests once more after a failed connection or a timeout. The first
   attempt gets half of the budget. An HTTP status is never sent again.

## Notes

- The detail is accepted only when it names the number asked.
- The key is encoded before it goes back in the address, so a `+` does not reach the server as
  a space. Errors leave out the request, since its key opens the consignment's page.
- The page names no zone. The booking and every row keep the office's wall clock in `local_time`.
  A row without a clock, or at exactly midnight, keeps its day. Text that is not a day and clock
  goes to `provider_time_text`.
- An OUT row is worded "Out To" the next office, at the office it left; an IN row "Inward At" the
  office it reached, as the status line words them. A job not seen yet keeps only its code.
- The status line usually repeats the newest row and is then kept once. A dated line newer than
  every row is added as a day.
- The page for a number the tracker holds nothing for, a made-up one included, echoes the number
  with every field empty and both tables with their headers alone; that page is not found. Any
  other page without those fields, a bot check or the site's blank error page is never read as
  not found.
- Some numbers show only their booking office with "Booked By" or with an office to contact,
  without a day or rows. They fail as listed without history.
- The consignee is kept as `receiver_name`. The destination center, the delivery receiver and the
  offices' addresses and phone numbers in the tooltips and the status line are not kept.
- Old tracking links carry the plain number after `docno=`, and only a twelve-digit value is read
  from them. The current site's links carry the encrypted key, which names no number.

## Limitations

- Delivery rows have not been seen on the current page. They are read as a day and clock, the
  delivering branch and a status, and are staged by that status.
- Older consignments lose their rows and fields, and then read as not found.
- The company's other site, `smespl.in`, now serves only an account login and is not used.

## Testing

`SHREE_MAHAVIR_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/shree-mahavir`

`SHREE_MAHAVIR_UNKNOWN_NUMBER` optionally checks that a made-up number reads as not found.
