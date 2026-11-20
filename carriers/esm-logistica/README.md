# ESM Logística

ESM Logística operates physical parcel and certified-mail services in Colombia.
Cali's municipal administration names it as its provider for official mail, and
the carrier publishes a guest number-only tracker under its own domain.

The adapter uses the `guia` parameter submitted by the guest search form. It
checks the guide printed on the result card and reads the current state and
dated timeline headings. It keeps the portal's local clock precision. Origin
preparation and undelivered summaries can appear without a corresponding dated
movement. The adapter leaves those summary dates unset. It skips delivery
proofs, maps, addresses, names and timeline remarks.

The corpus includes two guides from judicial records published in November 2026
and one from a public Corpoboyacá shipping label. The guest tracker confirmed a
timed delivery, origin-office preparation and an undelivered outcome. An
additional historic reference printed by the city of Neiva currently returns
the tracker’s explicit no-record response. Multiple numeric guide series appear
in these records, so select the carrier explicitly.

- [ESM Logística](https://esmlogistica.com/)
- [Cali's municipal carrier announcement](https://intranet.cali.gov.co/2025/10/27/la-alcaldia-de-cali-optimiza-la-gestion-de-correspondencia-con-la-reapertura-de-la-ventanilla-de-mensajeria/)
- [Guest tracking page](https://clientes.esmlogistica.com/seguimiento)
- [Neiva's public notice containing the absent reference](https://www.alcaldianeiva.gov.co/Ciudadanos/Normatividad/LIQ%20OFICIAL%20DE%20AFORO%202024LOA0156-PATRICIA%20LEGUIZAMO%20LOSADA.pdf)

Run the guest checks with `ESM_LOGISTICA_TRACKING_NUMBER=2150000003083433
ESM_LOGISTICA_MISSING_NUMBER=22000002381174 npx vitest run carriers/esm-logistica/adapter.live.test.ts`.
