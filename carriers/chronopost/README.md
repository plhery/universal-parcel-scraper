# Chronopost

La Poste's express arm, including Chrono Shop2Shop. No adapter of its own: La
Poste's unified feed answers Chronopost numbers, so tracking runs through
[`la-poste`](../la-poste/README.md).

- Events arrive with an empty `group`, so the event `code` is the only status
  key.
- Chronopost's dedicated postal prefixes select it directly; the La Poste rule excludes them.
- The app links to the Chronopost portal because that is the brand on the label.
- Other postal-shaped numbers can be confirmed by the same feed before using a universal
  provider. [Chronopost's tracking instructions](https://www.chronopost.fr/fr/faq/destinataire/ou-trouver-mon-numero-de-colis)
  describe the broad shape, which is a candidate for a lookup rather than a unique carrier rule.
- Not used: Chronopost's SOAP service (more consignment metadata than tracking
  needs, not meant for automated use) or scraping `chronopost.fr` (a second
  portal for no extra field).

The unified feed's identity checks and limitations follow the shared adapter.

`npm run test:carriers:live -- testing/frenchDirectCarriers.live.test.ts` checks
wrong-number handling without supplied credentials.
