# PressEx Logistics

[PressEx Logistics](https://www.pressex.co/) operates courier and consolidation services in Colombia and the United States. Select PressEx Logistics and enter the full carrier guide number.

The [official tracking page](https://www.pressex.co/seguimiento-courier) embeds the [PressEx guest tracker](https://plataforma.nuvix.co/auth/rastreoGuia/pressex). The adapter uses its public, read-only GraphQL operations to confirm the exact guide under the PressEx tenant and read movement records marked visible in the guest portal. It requests shipment status and history fields only.

The carrier's [tracking guide](https://www.pressex.co/_files/ugd/fa8e50_a5dc0c8b413146548d8185c8af2caae4.pdf) publishes a guide number whose live reply contains five dated milestones. PressEx supplies timestamp strings without a time zone. The adapter preserves those as local clocks and prefers the alternate movement time where the carrier gives one. The browser link opens the guest search form.

```sh
PRESSEX_TRACKING_NUMBER=BOG00100600000409 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/pressex-logistics/adapter.live.test.ts
```
