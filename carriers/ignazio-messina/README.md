# Ignazio Messina

Select Ignazio Messina explicitly and enter a container number from the [guest tracker](https://messinaline.it/cntr-tracking/).

## Retrieval

Messina's carrier-specific equipment route returns the movement rows for one submitted container. The response supplies equipment type and movement data without repeating the requested number, so the adapter uses the dedicated exact-number query. Bill and booking searches return a separate list response and are outside this adapter's scope.

The carrier can use the same code for an intended discharge and an actual discharge. The adapter reads both code and wording, excludes intended rows, and keeps the date and port printed for each actual movement.

## Testing

`IGNAZIO_MESSINA_TRACKING_NUMBER=… IGNAZIO_MESSINA_INVALID_NUMBER=… npm run test:carriers:live -- carriers/ignazio-messina`
