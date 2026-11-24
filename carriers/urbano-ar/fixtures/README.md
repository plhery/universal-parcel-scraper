# Fixtures

Pages of Urbano Argentina's tracker, trimmed of their styles, with the recipient's masked name,
street, phone and town replaced by `***` and `0000 LOCALIDAD`.

- `lookup-delivered.html`: `GET apis.urbano.com.ar/cespecifica/` for the first public sample in
  [`numbers.json`](../numbers.json), one row with a guide.
- `detail-delivered.html`: the scans `POST .../class/especifica_controller.php` lists for that row,
  ending with the delivery.
- `lookup-not-found.html`: the page for an invented code under shipper 2273, a row without a client
  record or product that reads "Sin información".
