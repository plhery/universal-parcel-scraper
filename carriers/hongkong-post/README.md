# Hongkong Post

Hongkong Post parcels use the [universal providers](../../providers/README.md).

## Retrieval

The [official tracker](https://webapp.hongkongpost.hk/en/mail_tracking2/index.html)
uses MTCaptcha text verification before posting to
`https://webapp1.hongkongpost.hk/api1/v1/mailTracking/mail-tracking-message-mtCaptcha`.
The verification token belongs to the browser session. Reading the challenge does
not establish that verification passed or that the tracker returned a shipment.

The older `MailTracking_app3/latestResult` route remains in the public page's
client code. There is no dedicated adapter for either flow.
The [Mail Service API](https://ec-ship.hongkongpost.hk/API-portal/index.jsp?lang=en_us)
requires registration.

## Limitations

Outbound tracking beyond departure from Hong Kong depends on the destination's
postal service.

## Testing

Provider live-test inputs and commands are documented in the
[provider READMEs](../../providers/README.md).
