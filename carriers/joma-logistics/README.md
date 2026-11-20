# JOMA Logistics NYC

JOMA's public tracker follows air cargo departures from New York to Tajikistan using the JL
reference on the invoice. The adapter calls the guest endpoint and verifies the whole
departure reference in the result.

The tracker reports milestones for the shared departure. The adapter reads the dates of
completed steps as calendar days and uses the step's own date when it differs from the
scheduled departure day. Arrival in Dushanbe marks the air leg's arrival.

Run the live test with `JOMA_LOGISTICS_NUMBER` supplied in the environment and
`npm run test:carriers:live -- carriers/joma-logistics`.
