# Amanat Logistics

Select Amanat Logistics and enter its tracking number. The
[guest tracker](https://www.amanatlogistics.com/tracking/orders) also accepts
the ACCI invoice number. The adapter checks the reference against the shipment
details and reads the milestones through the current step in the progress panel.

The carrier supplies calendar dates for some milestones. The public example
lists a delivery date earlier than several preceding transit dates, so the
adapter retains the delivery status and leaves its date unset. It keeps the
dates on the preceding milestones and leaves undated steps undated.

Set `AMANAT_LOGISTICS_AF_NUMBER` and run
`npm run test:carriers:live -- carriers/amanat-logistics-af` to verify a sample.
