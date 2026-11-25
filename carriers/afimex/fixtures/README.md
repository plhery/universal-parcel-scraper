# Fixtures

Results pages of `POST afimex.net/rastrea-envio-resultado-v2`, the form on Afimex's tracking page.
Each is trimmed to the results: the page's menus, sign-in forms and scripts are left out.

- `delivered.html`: the results for the public sample in [`numbers.json`](../numbers.json), a parcel
  documented at Matamoros and delivered at Ciudad Victoria. The recipient, couriers, operators and
  logins are replaced by placeholders, the signature by an empty image and the delivery place's
  coordinates by zeros.
- `not-found.html`: the results, with HTTP 200, for an invented code.
