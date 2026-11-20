# CootransTame

CootransTame, the Cooperativa de Transportadores de Tame, delivers freight and parcels within Colombia. Its public [Rastreo Envíos](https://www.cootranstame.com/rastreo-envios) form accepts a guide and a service type.

## How it works

1. `direct` opens the guest form for its Livewire snapshot, CSRF field, and anonymous session cookies.
2. It posts the guide and the form's Paqueteria option (`110`) to the form's native Livewire handler. If the carrier explicitly reports the guide absent, it checks the Mensajería option (`111`) within the same deadline.
3. It checks the echoed guide, service and returned shipment number. It reports dated status scans and the locations attached to those scans.

## Limitations

- The carrier supplies scan times as local wall clocks, with no UTC offsets.
- The link opens the tracking form, where the guide can be entered.
- Select CootransTame explicitly. Its detection entry remains open.

## Testing

Run `npm exec vitest -- run carriers/cootranstame/adapter.test.ts`. Set `COOTRANSTAME_TRACKING_NUMBER` and run `npm run test:carriers:live -- carriers/cootranstame` for the native check.
