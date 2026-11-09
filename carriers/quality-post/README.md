# Quality Post

Quality Post parcels use enabled universal providers. There is no dedicated adapter.

Grupo Qualitypost operates Mexican parcel and last-mile delivery services.

## Retrieval

The [guest tracker](https://wstracking.qualitypost.com.mx/portal_seguimiento) opens a
number from `info`. Its form posts `action=tracking`, `id_rastreo` and a reCAPTCHA v2
response to the same page. Opening the deep link only fills the form.

The [former tracker](https://tracking.qualitypost.com.mx/newtracking/seguimiento_envio)
reads `id` without a CAPTCHA. No current public reference establishes a dated history
through either route. Archived evidence remains quarantined in `numbers.json`.

[Zeus](https://app.qualitypost.com.mx/) asks for an employee identifier and PIN.
No official Android guest-tracking package has been identified.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
