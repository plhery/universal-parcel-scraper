# HRL Cargo

HRL Cargo provides road freight and partial truckload service in India. Its
public tracking form uses the docket or lorry receipt number. The form uses a
server action with a fresh set of public form fields, so the adapter reads the
form and submits it before checking the docket shown on the result card.

The carrier publishes docket `2202293` in the search field. The public result
confirms booking and dispatch in Indore and delivery in Bhopal. The adapter
keeps day precision and the branches on those dated steps. It uses the separate
status badge for the current summary and skips route and proof-of-delivery
panels. A public docket producing an explicit absence has yet to be verified.

The tracking link opens the carrier's form. Numeric docket lengths overlap
other carriers, and HRL also accepts manually assigned dockets.

- [HRL Cargo public consignment tracker and sample docket](https://www.hrlcargo.com/track/)
- [HRL Cargo network and freight services](https://www.hrlcargo.com/)

Run the guest check with `HRL_CARGO_TRACKING_NUMBER=2202293 npx vitest run
--config vitest.carriers-live.config.ts carriers/hrl-cargo/adapter.live.test.ts`.
