# Salam Pacific Indonesia Lines

Select Salam Pacific Indonesia Lines explicitly and enter the full container number from the carrier's shipping paperwork. [mySPIL](https://myspil.com/) offers the public Track & Trace form.

## Retrieval

The adapter submits the guest search and checks the container number in the result. It reads dated movements from the History panel using the carrier's printed local time. The route, estimates, cargo-ready date and billing fields belong to the shipment summary and stay out of the event history.

The container can appear on multiple voyages. The result reflects the movements SPIL currently shows for that equipment. Pickup of a container for stuffing stays unstaged.

## Testing

`SALAM_PACIFIC_INDONESIA_LINES_TRACKING_NUMBER=… SALAM_PACIFIC_INDONESIA_LINES_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/salam-pacific-indonesia-lines`
