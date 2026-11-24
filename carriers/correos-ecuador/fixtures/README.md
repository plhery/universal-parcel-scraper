# Fixtures

Pages Servicios Postales del Ecuador's tracker returns, without their scripts, stylesheets, inline images,
navigation and footer. ASP.NET's encrypted state is replaced with placeholders.

- `form.html`: the tracking page as a GET returns it, with the form the adapter posts back.
- `delivered.html`: the answer for the public sample in `numbers.json`, which an
  [archived ParcelPanel Correos del Ecuador page](https://web.archive.org/web/20251008094216/https://www.parcelpanel.com/couriers/correos-del-ecuador/)
  offered to try: a parcel from the United States that cleared customs in Quito and was
  delivered. The receiver's name and cédula are replaced with placeholders.
- `not-found.html`: the answer for a synthetic S10 code the tracker does not know.
