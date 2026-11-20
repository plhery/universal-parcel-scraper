# SITC Container Lines

SITC Container Lines publishes container movements through its [guest e-business tracker](https://ebusiness.sitcline.com/). Select the carrier explicitly and enter the container number. The result describes the equipment history currently available from SITC. Containers can appear on multiple sailings.

## Retrieval

The adapter sends the site's container movement search and checks the full container number on every row. It keeps the English movement codes, port names and offsetless scan times.

Vessel loading and inbound release of a laden box count as transit. The carrier uses the inbound delivery code for terminal gate-out. Empty equipment pickup, discharge and return stay in the history without changing the cargo stage.

## Testing

`SITC_CONTAINER_LINES_TRACKING_NUMBER=… SITC_CONTAINER_LINES_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/sitc-container-lines`
