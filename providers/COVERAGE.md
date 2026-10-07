# Carrier coverage by tracking source

The carriers in [coverage.json](coverage.json) are a curated comparison set, not a
market-share ranking. Provider results come from separate lookups on the same comparison reference;
unverified cells have no established result.
A direct sample names an alternative when that reference is outside the adapter's scope or
no longer available. The README counts only the direct cells that begin with a check mark and
the first provider reference. It leaves alternate samples out.

When replacing a comparison reference, rerun the adapter and every provider on the same
replacement. Keep other references as routing evidence. Adapter availability and successful
comparison lookups are separate counts.

The DHL references include Express shipments outside the dedicated DHL Paket adapter's
scope. Their public sources are in [the number corpus](../carriers/dhl/numbers.json).

OMGO is outside the comparison cohort. ParcelsApp returns OMGO history; the other
providers are unverified for it.

## Reading the table

A check mark means scan history came back. The number beside it counts projected rows,
partial histories included. Translations, repeated reports and postal exchange-office rows
can raise that count without adding progress. A summary alone, a challenge or a failed
identity check does not count as history. A negative on an expired reference says nothing
about current coverage.

<!-- GENERATED:coverage -->
| Carrier | Direct support | Direct sample | Ship24 | ParcelsApp | 17TRACK | Postal Ninja | UPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [DHL](../carriers/dhl/README.md) | Yes | Blocked | ✓ 10 | ✓ 14 | No history | ✓ 14 | ✓ 1 |
| [DHL Express](../carriers/dhl-express/README.md) | Yes | ✓ 23 | ✓ 23 | ✓ 23 | Unverified | Unverified | N/A |
| [UPS](../carriers/ups/README.md) | Yes | ✓ 11 | ✓ 1, partial | ✓ 11 | ✓ 11 | ✓ 11 | N/A |
| [FedEx](../carriers/fedex/README.md) | Yes | ✓ 14, intermittent | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | N/A |
| [USPS](../carriers/usps/README.md) | Yes | ✓ 11 | No history | No history | ✓ 11 | No history | N/A |
| [Amazon Logistics](../carriers/amazon-logistics/README.md) | Link only | Not tested | No history | Sign-in | No history | No history | N/A |
| [Amazon Shipping](../carriers/amazon-shipping/README.md) | Yes | ✓ 12 | ✓ 12 | ✓ 12 | No history | ✓ 12 | N/A |
| [Royal Mail](../carriers/royal-mail/README.md) | Yes (local Chromium) | ✓ 8 | No history | ✓ 1 | No history | ✓ 4 | No history |
| [Swiss Post](../carriers/swiss-post/README.md) | Yes | ✓ 8 | ✓ 8 | ✓ 8 | ✓ 8 | No history | N/A |
| [La Poste / Colissimo](../carriers/la-poste/README.md) | Yes | ✓ 15 | ✓ 11, partial | ✓ 16 | ✓ 14 | ✓ 26 | No history |
| [DPD Switzerland](../carriers/dpd/README.md) | Yes (Switzerland; optional postcode) | ✓ 4 | ✓ 1, partial | ✓ 4 | ✓ 4 | ✓ 4 | N/A |
| [DHL eCommerce](../carriers/dhl-ecommerce/README.md) | Yes | ✓ 16 | ✓ 11, partial | ✓ 36 | No history | ✓ 34 | N/A |
| [AliExpress / Cainiao](../carriers/aliexpress/README.md) | Yes | ✓ 17 | No history | ✓ 17 | ✓ 17 | ✓ 17 | N/A |
| [China Post](../carriers/china-post/README.md) | No adapter | Blocked | ✓ 1, partial | ✓ 1, partial | ✓ 39 | ✓ 17 | ✓ 1 |
| [EMS](../carriers/ems/README.md) | Yes | ✓ 7 | ✓ 6 | ✓ 18 | ✓ 24 | ✓ 6 | ✓ 6 |
| [SF Express](../carriers/sf-express/README.md) | Yes | ✓ 22 | No history | No history | ✓ 27 | No history | N/A |
| [GLS Germany](../carriers/gls-de/README.md) | Yes (postcode) | Not tested (postcode) | No history | No history | No history | No history | N/A |
| [GLS France](../carriers/gls-fr/README.md) | Yes | No history | No history | ✓ 4 | No history | No history | N/A |
| [GLS Switzerland](../carriers/gls-ch/README.md) | Yes (postcode) | Unverified | Unverified | Unverified | Unverified | Unverified | N/A |
| [Hermes Germany](../carriers/hermes-de/README.md) | Yes | No history | No history | No history | No history | No history | N/A |
| [Evri](../carriers/evri/README.md) | Yes (international) | ✓ 20 | No history | ✓ 21 | No history | No history | N/A |
| [Chronopost](../carriers/chronopost/README.md) | Yes (via La Poste) | No history | No history | No history | No history | No history | No history |
| [Mondial Relay](../carriers/mondial-relay/README.md) | Yes (postcode for short numbers) | No history | No history | No history | No history | No history | N/A |
| [InPost](../carriers/inpost/README.md) | Yes | ✓ 9 | ✓ 9 | ✓ 9 | ✓ 8 | No history | N/A |
| [PostNL](../carriers/spring-gds/README.md) | Yes | ✓ 16 | ✓ 16 | No history | No history | ✓ 16, partial | No history |
| [Canada Post](../carriers/canada-post/README.md) | Yes | No history; alternate ✓ 11 | ✓ 12 | ✓ 11 | ✓ 25 | Error | ✓ 1 |
| [Australia Post](../carriers/australia-post/README.md) | Yes | ✓ 12 | No history | No history | No history | ✓ 12, partial | N/A |
| [Japan Post](../carriers/japan-post/README.md) | Yes | ✓ 13 | ✓ 13, partial | ✓ 27 | ✓ 27 | ✓ 28, partial | ✓ 1 |
| [India Post](../carriers/india-post/README.md) | Yes | ✓ 21 | ✓ 21, partial | No history | ✓ 21 | No history | No history |
| [Poste Italiane](../carriers/poste-italiane/README.md) | Yes | No history | No history | No history | No history | No history | N/A |
| [Correos Spain](../carriers/correos-spain/README.md) | Yes | ✓ 12 | Error | ✓ 12, partial | ✓ 12 | No history | N/A |
| [bpost](../carriers/bpost/README.md) | Yes | ✓ 11 | No history | Postcode prompt | No history | No history | N/A |
| [Austrian Post](../carriers/austrian-post/README.md) | Yes | ✓ 9 | ✓ 9, partial | ✓ 9 | ✓ 9 | ✓ 9 | N/A |
| [PostNord](../carriers/postnord/README.md) | Yes | ✓ 6 | ✓ 6, partial | ✓ 6 | ✓ 6 | ✓ 7 | No history |
| [TNT](../carriers/tnt/README.md) | Yes | No history; alternate ✓ 1 | No history | No history | No history | No history | N/A |
| [Aramex](../carriers/aramex/README.md) | Yes | ✓ 16 | No history | No history | No history | ✓ 16 | N/A |
| [YunExpress](../carriers/yunexpress/README.md) | Yes (browser) | ✓ 23 | ✓ 14 | ✓ 15 | ✓ 14 | ✓ 15 | N/A |
| [4PX](../carriers/four-px/README.md) | Yes | ✓ 26 | ✓ 25 | ✓ 26 | ✓ 26 | ✓ 26 | N/A |
| [Yanwen](../carriers/yanwen/README.md) | Yes | ✓ 29 | ✓ 1, partial | ✓ 29 | ✓ 29 | No history | No history |
| [J&T Express](../carriers/j-and-t/README.md) | No adapter | Blocked (Philippines) | No history | No history | No history | No history | N/A |
| [JD Logistics](../carriers/jd-logistics/README.md) | Yes (international) | Unverified | Unverified | Unverified | Unverified | Refused | N/A |
| [ZTO Express](../carriers/zto/README.md) | No adapter | Not tested | Unverified | Unverified | Unverified | Unverified | N/A |
| [YTO Express](../carriers/yto/README.md) | Yes (China domestic) | ✓ 30 | Error | ✓ 30 | ✓ 20 | No history | N/A |
| [Yunda Express](../carriers/yunda/README.md) | Yes (China domestic) | Unverified; alternate ✓ 2 | Unverified | Unverified | Unverified | Unverified | N/A |
| [STO Express](../carriers/sto/README.md) | No adapter | Not tested | Unverified | Unverified | Unverified | Unverified | N/A |
| [Yamato Transport](../carriers/yamato/README.md) | Yes | ✓ 7 (yearless dates) | Error | Wrong carrier | No history | No history | N/A |
| [Correios Brazil](../carriers/correios-br/README.md) | Yes (local OCR) | ✓ 8 | ✓ 8 | No history | ✓ 8 | Error | No history |
| [Singapore Post](../carriers/singapore-post/README.md) | Yes | ✓ 9 | ✓ 4, partial | ✓ 12 | ✓ 18 | ✓ 11 | ✓ 4 |
| [Hongkong Post](../carriers/hongkong-post/carrier.json) | No adapter | Blocked | ✓ 26 | ✓ 35 | ✓ 17, partial | ✓ 35 | No history |
| [Korea Post](../carriers/korea-post/README.md) | Yes (international) | ✓ 20 | ✓ 36 | ✓ 41 | ✓ 28 | ✓ 27 | ✓ 1 |
| [Planzer](../carriers/planzer/README.md) | Yes | ✓ 4 | No history | No history | No history | No history | N/A |
| [Quickpac](../carriers/quickpac/README.md) | Yes (via Planzer) | No history | No history | No history | No history | No history | N/A |
| [DPD France](../carriers/dpd-fr/README.md) | Yes | ✓ 10 | ✓ 10, partial | ✓ 5, partial | No history | No history | N/A |
| [Parcelforce Worldwide](../carriers/parcelforce/carrier.json) | No adapter | Not tested | No history | No history | No history | ✓ 3 | No history |
| [Purolator](../carriers/purolator/README.md) | Yes | ✓ 12, intermittent | No history | ✓ 12 | ✓ 12 | Refused | N/A |
| [OnTrac](../carriers/ontrac/README.md) | Yes | ✓ 14 | No history | ✓ 14 | No history | ✓ 14 | N/A |
| [Delhivery](../carriers/delhivery/README.md) | Yes | ✓ 2, partial (one undated scan and a status snapshot) | No history | No history | No history | No history | N/A |
| [Blue Dart](../carriers/blue-dart/README.md) | Yes | ✓ 15 | No history | No history | No history | No history | N/A |
| [DTDC](../carriers/dtdc/README.md) | Yes | ✓ 9 | No history | ✓ 37 | No history | No history | N/A |
| [Ninja Van](../carriers/ninja-van/README.md) | Yes (Malaysia NLMY) | No history; alternate ✓ 5 | No history | No history | No history | No history | N/A |
| [Packeta](../carriers/packeta/README.md) | Yes | ✓ 6 | ✓ 11 | No history | No history | ✓ 12 | N/A |
| [Poczta Polska](../carriers/poczta-polska/README.md) | Yes | ✓ 5 | ✓ 10 | ✓ 19 | ✓ 21 | ✓ 18 | ✓ 6 |
| [Bring](../carriers/bring-posten/README.md) | Yes | ✓ 12 | ✓ 12 | ✓ 15 | ✓ 19 | ✓ 16 | ✓ 3 |
| [Posti](../carriers/posti/README.md) | Yes | Unverified | Unverified | Unverified | Unverified | Unverified | N/A |
| [An Post](../carriers/an-post/carrier.json) | No adapter | Not tested | ✓ 4 | ✓ 4 | ✓ 4 | ✓ 4 | No history |
| [CTT Portugal](../carriers/ctt/README.md) | Yes | ✓ 4 | ✓ 4 | ✓ 5 | ✓ 5 | ✓ 3 | ✓ 2 |
| [CTT Express](../carriers/ctt-express/README.md) | Yes | ✓ 5 | ✓ 5 | ✓ 5 | ✓ 4 | ✓ 6 | N/A |
| [BRT](../carriers/brt/README.md) | Yes | ✓ 9 | No history | ✓ 23 | No history | ✓ 5 | N/A |
| [SEUR](../carriers/seur/README.md) | Yes | No history; alternate ✓ 6 | No history | ✓ 4 | ✓ 4 | ✓ 4 | N/A |
| [Correos Express](../carriers/correos-express/README.md) | Yes | ✓ 9 | ✓ 9 | ✓ 9 | No history | No history | N/A |
| [MRW](../carriers/mrw/README.md) | Yes | ✓ 14 | ✓ 14 | ✓ 14 | No history | ✓ 14 | N/A |
| [NACEX](../carriers/nacex/README.md) | Yes | ✓ 13 | Refused | Refused | Refused | Refused | N/A |
| [Colis Privé](../carriers/colis-prive/README.md) | Yes (postcode) | Not tested (postcode) | No history | No history | No history | No history | N/A |
| [Relais Colis](../carriers/relais-colis/README.md) | Yes | ✓ 4 | No history | ✓ 4 | No history | Refused | N/A |
| [Paack](../carriers/paack/README.md) | Yes (postcode) | Not tested (postcode) | No history | No history | No history | No history | N/A |
| [Asendia](../carriers/asendia/README.md) | Yes (Asendia USA) | ✓ 5 | ✓ 2, partial | ✓ 6 | Error | ✓ 3, partial | ✓ 2 |
| [Landmark Global](../carriers/landmark-global/README.md) | Yes | ✓ 14 | ✓ 14 | ✓ 21 | No history | ✓ 21 | N/A |
| [NZ Post](../carriers/nz-post/README.md) | Yes | ✓ 16 | ✓ 20 | ✓ 20 | ✓ 16 | ✓ 20 | ✓ 4 |
| [Pos Malaysia](../carriers/pos-malaysia/README.md) | Yes | ✓ 2 | Error | ✓ 2 | ✓ 2 | No history | No history |
| [Thailand Post](../carriers/thailand-post/carrier.json) | No adapter | Not tested | ✓ 8 | ✓ 8 | No history | ✓ 8 | No history |
| [Ukrposhta](../carriers/ukrposhta/README.md) | Yes | ✓ 22; alternate ✓ 14 | ✓ 30 | ✓ 33 | ✓ 45 | ✓ 33 | Error |
| [Estafeta](../carriers/estafeta/README.md) | Yes | ✓ 4 | No history | No history | No history | No history | N/A |
| [Correos de Chile](../carriers/correos-chile/README.md) | Yes | No history; alternate ✓ 1 | No history | No history | ✓ 13 | No history | No history |
| [The Courier Guy](../carriers/the-courier-guy/README.md) | Yes | ✓ 14; alternate ✓ 13 | No history | No history | No history | Refused | N/A |
| [GEODIS](../carriers/geodis/README.md) | Yes | Summary only | No history | Postcode prompt | ✓ 4, partial | ✓ 2 | N/A |
| [Dachser](../carriers/dachser/README.md) | Yes (tracking link) | Not tested (link) | No history | No history | No history | No history | N/A |
| [Old Dominion](../carriers/old-dominion/carrier.json) | No adapter | Not tested | Unverified | Unverified | Unverified | Unverified | N/A |
| [Swiss Post Cargo](../carriers/swiss-post-cargo/README.md) | Yes | Unverified | Unverified | Unverified | Unverified | Unverified | N/A |
| [PostLogistics](../carriers/postlogistics/README.md) | Yes | Unverified | Unverified | Unverified | Unverified | Unverified | N/A |
| [Hermes Einrichtungs-Service](../carriers/hermes/README.md) | Yes | ✓ 10 | No history | No history | No history | No history | N/A |
| [Heppner](../carriers/heppner/README.md) | Yes (postcode) | Not tested (postcode) | No history | Wrong carrier | No history | Refused | N/A |
| [Ciblex](../carriers/ciblex/README.md) | Yes | ✓ 7 | No history | Postcode prompt | No history | No history | N/A |
| [C Chez Vous](../carriers/c-chez-vous/README.md) | Yes | No history | No history | No history | No history | Refused | N/A |
| [Colisweb](../carriers/colisweb/README.md) | Yes | ✓ 2 | Wrong carrier | No history | No history | Refused | N/A |
| [Delivengo](../carriers/delivengo/README.md) | Yes (via La Poste) | No history | No history | No history | No history | No history | No history |
| [UniUni](../carriers/uniuni/README.md) | Yes | ✓ 6 | ✓ 6 | ✓ 19 | ✓ 6 | ✓ 21 | N/A |
| [SpeedX](../carriers/speedx/carrier.json) | No adapter | Not tested | No history | No history | ✓ 2 | No history | N/A |
| [GOFO Express](../carriers/gofo/README.md) | Yes | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | ✓ 14 | N/A |
| [Ecoscooting](../carriers/ecoscooting/README.md) | Yes | ✓ 6 | ✓ 6, partial | ✓ 6, partial | No history | ✓ 22 | N/A |
| [TIPSA](../carriers/tipsa/README.md) | Yes | ✓ 13 | No history | ✓ 13 | No history | No history | N/A |
| [Canpar](../carriers/canpar/README.md) | Yes | ✓ 11 | No history | ✓ 11 | No history | ✓ 11 | N/A |
| [DPD Germany](../carriers/dpd-de/README.md) | Yes (Germany; optional postcode) | ✓ 4 | Unverified | Unverified | Unverified | Unverified | N/A |
| [DPD UK](../carriers/dpd-uk/README.md) | Yes (UK parcel numbers) | ✓ 7 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Evri UK](../carriers/evri-uk/README.md) | Yes (local Chromium) | ✓ 6 | Unverified | Unverified | Unverified | Unverified | N/A |
| [SpeedPAK](../carriers/speedpak/README.md) | Yes | ✓ 14 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Intelcom / Dragonfly](../carriers/intelcom/README.md) | Yes (Canada) | Not found; alternate ✓ 6 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Ekart](../carriers/ekart/README.md) | Yes (ecommerce) | ✓ 1 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Xpressbees](../carriers/xpressbees/README.md) | Yes (seller-platform AWBs) | Alternative ✓ 42 | Unverified | Unverified | Unverified | Unverified | N/A |
| [LBC Express](../carriers/lbc-express/README.md) | Yes (local Chromium) | Unverified; alternate ✓ 6 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Nova Poshta (Ukraine)](../carriers/nova-poshta/README.md) | Yes (Ukraine) | ✓ 10 | Unverified | Unverified | Unverified | Unverified | N/A |
| [SPX Express Philippines](../carriers/spx-ph/README.md) | Yes (Philippines) | ✓ 10 | Unverified | Unverified | Unverified | Unverified | N/A |
| [CNE Express](../carriers/cne/README.md) | Yes | ✓ 9 | Unverified | Unverified | Unverified | Unverified | N/A |
| [Sagawa Express](../carriers/sagawa/README.md) | No adapter | Blocked | Unverified | Unverified | Unverified | Unverified | N/A |
<!-- /GENERATED:coverage -->

<!-- GENERATED:lookup-order -->
| Source | Carriers with history | Full | Partial | Only source |
| --- | ---: | ---: | ---: | ---: |
| Ship24 | 43 | 28 | 15 | 0 |
| ParcelsApp | 54 | 48 | 6 | 5 |
| 17TRACK | 43 | 39 | 4 | 4 |
| Postal Ninja | 44 | 38 | 6 | 2 |

With Postal Ninja enabled, carriers without their own order use ParcelsApp → Ship24 → Postal Ninja → 17TRACK. These carriers have their own:

| Carrier | Order |
| --- | --- |
| DHL Express | Ship24 → ParcelsApp → Postal Ninja → 17TRACK |
| UPS | ParcelsApp → Postal Ninja → 17TRACK → Ship24 |
| USPS | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| Royal Mail | ParcelsApp → Postal Ninja → Ship24 → 17TRACK |
| Swiss Post | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| La Poste / Colissimo | ParcelsApp → Postal Ninja → 17TRACK → Ship24 |
| DPD Switzerland | ParcelsApp → Postal Ninja → 17TRACK → Ship24 |
| DHL eCommerce | ParcelsApp → Postal Ninja → Ship24 → 17TRACK |
| AliExpress / Cainiao | ParcelsApp → Postal Ninja → 17TRACK → Ship24 |
| China Post | Postal Ninja → 17TRACK → ParcelsApp → Ship24 |
| SF Express | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| InPost | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| PostNL | Ship24 → Postal Ninja → ParcelsApp → 17TRACK |
| Canada Post | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Australia Post | Postal Ninja → ParcelsApp → Ship24 → 17TRACK |
| Japan Post | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| India Post | 17TRACK → Ship24 → ParcelsApp → Postal Ninja |
| Correos Spain | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| bpost | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| Austrian Post | ParcelsApp → Postal Ninja → 17TRACK → Ship24 |
| PostNord | ParcelsApp → Postal Ninja → 17TRACK → Ship24 |
| Aramex | Ship24 → Postal Ninja → 17TRACK → ParcelsApp |
| Yanwen | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| JD Logistics | ParcelsApp → Ship24 → 17TRACK |
| YTO Express | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| Yamato Transport | Ship24 → Postal Ninja → 17TRACK |
| Correios Brazil | Ship24 → Postal Ninja → 17TRACK → ParcelsApp |
| Singapore Post | ParcelsApp → Postal Ninja → 17TRACK → Ship24 |
| Korea Post | ParcelsApp → Ship24 → 17TRACK → Postal Ninja |
| Parcelforce Worldwide | Postal Ninja → ParcelsApp → Ship24 → 17TRACK |
| Purolator | ParcelsApp → 17TRACK → Ship24 |
| OnTrac | ParcelsApp → Postal Ninja → Ship24 → 17TRACK |
| DTDC | ParcelsApp → Ship24 → 17TRACK |
| Packeta | Ship24 → Postal Ninja → ParcelsApp → 17TRACK |
| BRT | ParcelsApp → Postal Ninja → Ship24 → 17TRACK |
| SEUR | ParcelsApp → Postal Ninja → 17TRACK → Ship24 |
| Relais Colis | ParcelsApp → Ship24 → 17TRACK |
| Pos Malaysia | ParcelsApp → 17TRACK → Ship24 → Postal Ninja |
| Ukrposhta | Ship24 → Postal Ninja → 17TRACK → ParcelsApp |
| Correos de Chile | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| The Courier Guy | ParcelsApp → Ship24 → 17TRACK |
| GEODIS | Postal Ninja → 17TRACK → ParcelsApp → Ship24 |
| Heppner | Ship24 → 17TRACK |
| C Chez Vous | ParcelsApp → Ship24 → 17TRACK |
| Colisweb | ParcelsApp → 17TRACK |
| SpeedX | 17TRACK → ParcelsApp → Ship24 → Postal Ninja |
| Ecoscooting | Postal Ninja → ParcelsApp → Ship24 → 17TRACK |
| Canpar | ParcelsApp → Postal Ninja → Ship24 → 17TRACK |
<!-- /GENERATED:lookup-order -->

## Retrieval limits

The catalog declares supported inputs and routes. Some anonymous trackers require a postcode,
capability URL, browser service or interactive verification. Dedicated adapters reject
unbound replies, wrong parcel identities and ambiguous multi-piece shipments. Unresolved
scan clocks remain local. See each [carrier README](../carriers/) for its scope and constraints.

## Method

[scripts/coverage-probe.mjs](../scripts/coverage-probe.mjs) runs adapters and providers independently
with bounded deadlines. Keep its input references outside the repository. Review grades before
writing coverage.json, including partial history, stale references, wrong carrier and refused
formats. Extra references inform provider ordering but are not averaged into the README's
comparison. Run `npm run generate` to update the tables and summary.
