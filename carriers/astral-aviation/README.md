# Astral Aviation Cargo

Astral Aviation operates air cargo services from its hubs in Nairobi and Dubai. Its
[guest tracker](https://astral.fr8booking.com/trackAndTrace) takes the 485 prefix and
eight-digit waybill serial.

The adapter uses the `GET /dashboard-widget-detail/awbTracking` request made by that page
with Astral's public tenant label. It confirms the whole waybill in the reply and each
reported message. It reads the dated booking and departure messages with their available
clock precision. Flight schedules, unsigned template rows, cancelled messages and package
details stay out of the events.

Set `ASTRAL_AVIATION_NUMBER` and run
`npm run test:carriers:live -- carriers/astral-aviation` to verify a sample.
