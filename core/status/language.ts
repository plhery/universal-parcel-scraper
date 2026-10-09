import type { Stage } from '../../generated/catalog.js';
import type { CarrierStatus } from '../result/index.js';

/** Instructions, uncertainty and a return in progress do not prove sender delivery. */
export function nonterminalEnglishReturn(description: string): boolean {
  const text = description.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')
    .replace(/\bwon't\b/g, 'will not').replace(/\bshan't\b/g, 'shall not')
    .replace(/\bcan't\b|\bcannot\b/g, 'can not').replace(/\b([a-z]+)n't\b/g, '$1 not');
  // Bind the negative or modal to this sender-delivery phrase. A previous
  // failed recipient delivery does not negate an affirmative sender return.
  if (/\b(?:will|would|should|shall|must|may|might|can|could|ought to|needs? to|to) (?:(?:not|never|yet|still|already|soon|shortly|eventually|possibly|probably) )*(?:be|have been) delivered (?:back )?to (?:the )?(?:sender|shipper)\b|\b(?:not|never)(?: yet| already| still)? (?:(?:have|has|be|been|being) )*delivered (?:back )?to (?:the )?(?:sender|shipper)\b|\bbeing delivered (?:back )?to (?:the )?(?:sender|shipper)\b/.test(text)) return true;
  return /\breturn(?:ing)? to (?:the )?sender\b|\b(?:will|would|should|shall|must|may|might|can|could|ought to|needs? to|to) (?:(?:not|never|yet|still|already|soon|shortly|eventually|possibly|probably) )*(?:be|have been) returned to (?:the )?sender\b|\b(?:not|never)(?: yet| already| still)? (?:(?:have|has|be|been|being) )*returned to (?:the )?sender\b|\bbeing returned to (?:the )?sender\b|\breturn (?:has been )?(?:initiated|requested|started)\b/.test(text);
}

function comparable(description: string): string {
  return description.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[’‘]/g, "'").replace(/ł/g, 'l').replace(/[_–—-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
}

// One character of the same sentence: a dot inside a date or "a.m." does not end it.
const SENTENCE = String.raw`(?:[^.;!?]|\.(?=\S))`;
/**
 * A delivery still to come: a forecast, a notice, an instruction or a
 * condition such as paying duties, from its verb to the end of the sentence.
 * Delivery back to the sender is a return and stays with the return rules.
 */
const DELIVERY_FORECAST = new RegExp(`(?:${[
  String.raw`\b(?:will|would|shall|should|may|might|must|won't|can(?! ?not\b)|could(?! not\b))(?: (?:not|now|then|still|also|likely|probably|possibly|hopefully|soon|shortly|only|normally|usually|again|today|tomorrow))* be delivered\b(?! (?:back )?to (?:the )?(?:sender|shipper)\b)`,
  String.raw`\b(?:sera|seront|serait|seraient|va etre|vont etre|doit etre|doivent etre|devrait etre|devraient etre|pourra etre|pourront etre|pourrait etre)(?: \w+){0,2}? livree?s?\b(?! a l'expediteur)`,
  String.raw`\b(?:wird|werden|soll|sollte|sollen|sollten)\b${SENTENCE}*?(?<!\bnicht )\bzugestellt\b`,
  String.raw`\bvoraussichtlich\w*\b${SENTENCE}*?\b(?:zugestellt|zustellung)\b|\b(?:zustellung|zustelltermin) (?:(?:ist|erfolgt) )?(?:voraussichtlich|geplant)\b`,
  String.raw`\b(?:sara|saranno|verra|verranno|potra essere|potrebbe essere|dovrebbe essere|dovra essere)(?: \w+){0,2}? consegnat[oaie]\b(?! al mittente)`,
  String.raw`(?<!\bnao )\b(?:sera|seran|serao|va a ser|van a ser|vai ser|vao ser)(?: (?:hoy|manana|hoje|amanha|pronto|proximamente|brevemente|en breve|em breve))? (?:entregad[oa]s?|repartid[oa]s?|entregues?)\b(?! (?:al|ao|a la|a) (?:remitente|remetente|origen|origem)\b)|\bse (?:le |te |lo |la |les )?entregaran?\b`,
].join('|')})${SENTENCE}*`, 'g');

/**
 * What a description reports besides the delivery it announces, in the
 * comparable form the language rules read, or undefined when it announces
 * none. Such a notice is no movement: "Arrived at the depot, will be
 * delivered tomorrow" is in transit and "Will be delivered tomorrow" has no
 * stage, so the previous one stands.
 */
export function deliveryForecastRemainder(description: string): string | undefined {
  const text = comparable(description);
  const rest = text.replace(DELIVERY_FORECAST, ' ');
  return rest === text ? undefined : comparable(rest.replace(/^[\s,;:.!?]+|[\s,;:]+$/g, ''));
}

/** What a carrier does once it has the parcel. */
const CARRIER_STEP = String.raw`(?:dispatched|despatched|shipped|sent|received|processed|handed (?:over|in)|posted)\b`;
/** A handover to a carrier or courier, not to the recipient's side or to customs. */
const HANDED_TO_CARRIER = String.raw`handed (?:over )?to (?!(?:the |a |an |your )?(?:recipient|addressee|consignee|customer|receiver|neighbou?r|customs|you|person)\b)`;
/**
 * A step the carrier has not taken yet ("not yet received", "not dispatched
 * yet") or a handover that has not happened ("has not been handed over to
 * GLS"), from the negation to the end of its sentence.
 */
const NOT_YET = new RegExp(String.raw`(?:\bnot (?:yet (?:been )?${CARRIER_STEP}|(?:been )?${CARRIER_STEP}(?: \w+){0,3}? yet\b)|(?:\bnot|n't)(?: been)? ${HANDED_TO_CARRIER})${SENTENCE}*`, 'g');

/** A handover the carrier made, not a pickup order passed on or the sender's own hand-in. */
const HANDED_TO = String.raw`(?<!\b(?:(?:pick ?up|collection) (?:order|request)|sender|shipper|seller|merchant|consignor)(?: has| have)?(?: been)? )\bhanded (?:over )?to `;
/**
 * A courier no name or role sets apart: the one delivering the parcel. A
 * "SingPost courier", a "courier company" or The Courier Guy is another network.
 */
const COURIER = String.raw`(?:(?:the|a|an|our|your) )?(?:delivery )?couriers?\b(?! (?:compan|service|partner|network|guy\b))`;
const HANDED_TO_COURIER = new RegExp(`${HANDED_TO}${COURIER}`);
const HANDED_TO_NETWORK = new RegExp(String.raw`${HANDED_TO}(?!${COURIER})(?:the |a |an |our |your )?(?:[\w-]+ ){0,2}?(?:courier|carrier)s?\b`);

/** The side of customs a scan may name: "import", "export", "import/export". */
const CUSTOMS_SIDE = String.raw`(?:(?:import|export)(?:\/(?:import|export))? |local |destination |origin )?`;
/**
 * Clearance that has not happened yet: negated, pending, announced or bound
 * to a condition ("once released from customs"). Each phrase names customs or
 * clearance itself, so a notice about something else passes on.
 */
const CUSTOMS_PENDING = new RegExp([
  String.raw`attend d'etre libere|attente de liberation|wartet auf.*freigabe|attesa di svincolo`,
  String.raw`(?:customs|clearance).*\bnot\b.*(?:clear|complet|releas)|customs (?:not cleared|clearance not completed)|not.*released by customs`,
  String.raw`(?:\bnot|n't|\bnever|\byet to)\b(?: (?:yet|been|be|being|have|has|had|fully|still))* (?:released|cleared|left|exited|out of|passed)\b${SENTENCE}*?\bcustoms\b`,
  String.raw`\b(?:will|would|shall|should|may|might|must|can|could|once|when|until|till|before|unless|as soon as|needs? to|has to|have to|yet to|waiting to|expected to|about to)\b(?: \w+){0,3}? (?:be |been |get |gets |is |are |has been |have been )?(?:released|cleared)\b${SENTENCE}*?\bcustoms\b`,
  String.raw`\b(?:customs|clearance)\b${SENTENCE}*?\b(?:will|would|shall|should|may|might|must|can|could|once|when|until|till|before|unless|as soon as|needs? to|has to|have to|yet to|waiting to|expected to|about to|to)\b(?: \w+){0,2}? (?:be |been |get |gets |is |are |has been |have been )?(?:released|cleared|completed?|finished|done)\b`,
  String.raw`\b(?:be|being) (?:released|cleared) (?:from |by |through |out of )?(?:the )?${CUSTOMS_SIDE}customs\b|\bclearance (?:is )?(?:in progress|ongoing|under way|underway)\b|\b(?:be|being) customs cleared\b`,
  String.raw`dedouanement.*(?:non termine|pas termine)|\b(?:pas|non|jamais)\b(?: (?:encore|ete|etre|completement|totalement))* (?:dedouane|(?:sorti|libere)e?s? (?:de |par )?(?:la )?douane)|\b(?:sera|seront|serait|va etre|vont etre|doit etre|doivent etre|devra etre|devrait etre|pourra etre|en attente d'etre)(?: \w+){0,2}? (?:dedouane|libere)`,
  String.raw`zollabfertigung.*nicht abgeschlossen|nicht.*zoll.*freigegeben|\bnicht (?:\w+ )?verzollt\b|\b(?:wird|werden|muss|mussen|soll|sollen|kann|konnen)\b${SENTENCE}*?\bverzollt\b|\b(?:verzollung|zollabfertigung|zollfreigabe|zollkontrolle)\b${SENTENCE}*?\b(?:nicht|steht aus|ausstehend)\b`,
  String.raw`sdoganamento.*non completato|\bnon\b(?: \w+){0,3}? (?:sdoganat|uscit[oaie] dalla dogana|svincolat)|\b(?:sara|saranno|verra|verranno|deve essere|devono essere|dovra essere|in attesa di essere|attende di essere)(?: \w+){0,2}? sdoganat`,
  String.raw`\b(?:no|sin)\b(?: \w+){0,3}? (?:(?:liberad|despachad)[oa]s?|salido|salio|sale|salir) (?:por|de|en|desde) (?:la )?aduana|\b(?:sera|seran|va a ser|van a ser|debe ser|deben ser|pendiente de|en espera de|a la espera de|esperando)\b(?: \w+){0,2}? (?:(?:liberad|despachad)[oa]s?|liberacion|despacho|salida)\b${SENTENCE}*?\baduan[ae]`,
  String.raw`\bnao\b(?: \w+){0,3}? (?:desalfandegad[oa]s?|desembaracad[oa]s?|(?:liberad[oa]s?|saiu) (?:pela|na|da|de) (?:alfandega|aduana|fiscalizacao))\b|\b(?:aguardando|a aguardar|aguarda|em espera de|pendente de|sera|serao|vai ser|deve ser)\b(?: \w+){0,2}? (?:desalfandeg|(?:liberad|liberacao|desembarac)\w*${SENTENCE}*?\b(?:alfandeg|aduan[ae]|fiscalizacao))`,
  String.raw`\b(?:nie|oczekuje na|czeka na|w trakcie|przed)\b(?: \w+){0,2}? (?:odpraw|zwolnion)\w*${SENTENCE}*?\b(?:celn|urzad)`,
].join('|'));
/** Clearance completed or the parcel released, in each language. */
const CUSTOMS_RELEASED = new RegExp([
  String.raw`\bclearance\b${SENTENCE}*?\b(?:complete|completed|finished|done|success|successful|successfully|concluded|granted|approved|obtained)\b`,
  String.raw`(?:leaving|departed from|left|exited|exiting|out of|passed(?: through)?) (?:the )?${CUSTOMS_SIDE}customs\b(?! (?:to|for) (?:the )?(?:sender|shipper)\b)`,
  String.raw`completion of customs|released by (?:customs|a government agency)|\breleased (?:from|out of|at) (?:the )?${CUSTOMS_SIDE}customs\b|\breturned from (?:the )?${CUSTOMS_SIDE}customs\b(?! to\b)`,
  String.raw`customs (?:cleared|(?:has |have )?released)|\bcustoms (?:release|inspection|examination|check|control) (?:has been |was |is )?(?:granted|completed?|finished|done|passed)\b|\bcleared (?:through |by |the )?${CUSTOMS_SIDE}customs\b`,
  String.raw`formalites.*(?:terminee|achevee)|dedouanement.*(?:termine|acheve)|fin du dedouanement|\bdedouanement (?:(?:du colis|de (?:votre |l'|ce )?(?:colis|envoi)) )?(?:(?:a ete|est) )?(?:effectue|realise|reussi|valide|finalise)e?s?\b|\bdedouane(?:e|s|es)?\b|libere.*(?:douane|autorite)|douane.*libere|\bsorti(?:e|s|es)? de (?:la )?douane\b`,
  String.raw`zollabfertigung.*abgeschlossen|(?:zoll|behorde).*freigegeben|\bverzollt\b|\b(?:verzollung|zollabfertigung|zollkontrolle|zollprufung|zollformalitaten)\b${SENTENCE}*?\b(?:abgeschlossen|erledigt|beendet)\b|\b(?:verzollung|zollfreigabe) (?:ist |wurde )?(?:erfolgt|erteilt)\b(?! durch)|\b(?:den zoll|das zolllager|die zollstelle|das zollamt) verlassen\b`,
  String.raw`sdoganamento.*completato|completamento.*sdoganamento|svincolat.*(?:dogana|autorita)|\bsdoganat[oaie]\b|\bsdoganamento\b${SENTENCE}*?\b(?:effettuato|concluso|avvenuto|terminato|ultimato)\b|\bsvincolo (?:doganale )?(?:e )?(?:avvenuto|effettuato|concesso|completato|ottenuto)\b|\busci(?:to|ta|ti|te) dalla dogana\b|\bcontrollo doganale (?:e )?(?:superato|completato|concluso|terminato)\b`,
  String.raw`\b(?:liberad|despachad)[oa]s? (?:por|de|en|desde) (?:la |las )?aduanas?\b|\b(?:salida|salio|ha salido|sale) (?:de|desde) (?:la )?aduana\b|\b(?:tramites|despacho|gestion(?:es)?|proceso)(?: (?:de|del|en))?(?: (?:la |las |los )?aduanas?| aduaner[oa]s?)+ (?:(?:ha sido|han sido|fue|fueron) )?(?:finalizad|completad|terminad|concluid|realizad)[oa]s?\b`,
  String.raw`\b(?:liberad|desembaracad)[oa]s? (?:pela|na|da) (?:alfandega|aduana|fiscalizacao(?: aduaneira)?|receita federal)\b|\bdesalfandegad[oa]s?\b|\b(?:desalfandegamento|desembaraco(?: aduaneiro)?|fiscalizacao aduaneira|tramites aduaneiros|processo aduaneiro) (?:(?:foi|esta|foram) )?(?:concluid|finalizad|terminad|realizad|efetuad|efectuad)[oa]s?\b|\b(?:saiu|saida) (?:da|de) (?:alfandega|aduana)\b`,
  String.raw`\bodprawa celna (?:\w+ )?(?:zakonczona|zakonczyla sie|ukonczona)\b|\bodprawion[aey] celnie\b|\bzwolnion[aey] (?:przez urzad celny|z urzedu celnego)\b|\bopuscil[aoy]? urzad celny\b`,
].join('|'));
/** A parcel customs holds, detains or retains, in each language. */
const CUSTOMS_HOLD = new RegExp(String.raw`\bcustoms (?:hold|detention)\b|\b(?:held|on hold|detained|retained) (?:by|in|at) (?:the )?${CUSTOMS_SIDE}customs?\b|retenu en douane|vom zoll zuruckgehalten|fermo in dogana|retenido en aduana|retido na alfandega|zatrzyman[ay] przez (?:urzad celny|cel)`);
/** A customs problem or hold that has ended: the parcel moves on. */
const CUSTOMS_PROBLEM_ENDED = new RegExp([
  String.raw`\b(?:released|freed|cleared) (?:from|of) (?:the )?customs (?:hold|detention|inspection|examination)\b`,
  String.raw`\bcustoms (?:issue|problem|hold|detention)s? (?:(?:has|have) been |was |were |is |are )?(?:now )?(?:resolved|solved|lifted|released|cleared|removed|fixed)\b`,
  String.raw`\bprobleme (?:douanier|de douane) (?:a ete |est )?(?:resolu|regle|leve)e?\b|\bzollproblem (?:wurde |ist )?(?:behoben|gelost|geklart)\b|\bproblema doganale (?:e stato )?risolto\b|\bproblema (?:de|en la) aduana (?:ha sido |fue )?(?:resuelto|solucionado)\b|\bproblema (?:alfandegario|na alfandega) (?:foi )?resolvido\b`,
].join('|'));

/** A hold the recipient asked for, worded "at the recipient's request" in each language. */
const RECIPIENT_REQUEST = String.raw`(?:(?:at|per|by|upon|on|following|as per) (?:the )?(?:recipient|addressee|consignee|customer|receiver)(?:'s|s')? request|(?:at|per|by|upon|on|following) (?:the )?request of (?:the )?(?:recipient|addressee|consignee|customer|receiver)|requested by (?:the )?(?:recipient|addressee|consignee|customer|receiver)|(?:recipient|addressee|consignee|customer|receiver)(?: has)? requested\b|a la demande (?:du|de la) (?:destinataire|cliente?)|(?:auf|nach) (?:wunsch|anweisung|verlangen) (?:des|der) (?:empfangers|empfangerin|kunden|kundin)|auf (?:empfanger|kunden)wunsch|su richiesta del (?:destinatario|cliente)|(?:a|por) (?:peticion|solicitud|pedido) del (?:destinatario|cliente)|a pedido do (?:destinatario|cliente)|na (?:prosbe|zyczenie) (?:odbiorcy|adresata|klienta))`;
const HOLD = String.raw`\b(?:on hold|held|hold|holding|retenu(?:e|s|es)?|en attente|mise? en instance|zuruckgehalten|zuruckbehalten|angehalten|gelagert|trattenut[oaie]|fermo|in sosta|retenid[oa]s?|en espera|retid[oa]s?|zatrzyman[aey]|wstrzyman[aey])\b`;
const RECIPIENT_HOLD = new RegExp(`${HOLD}${SENTENCE}*?${RECIPIENT_REQUEST}|${RECIPIENT_REQUEST}${SENTENCE}*?${HOLD}`);
/** Where a held parcel waits for the recipient to collect it. */
const COUNTER = /post office|postal outlet|pick ?up|collection|counter|retail (?:location|outlet)|bureau de poste|point (?:de )?retrait|point relais|filiale|abholung|ufficio postale|ritiro|oficina|recogida|levantamento|agencia/;

/** The recipient's side by its role, not a service desk or an agent acting for it. */
const RECIPIENT = String.raw`(?:recipient|addressee|consignee|customer|receiver)s?\b(?!'| (?:service|care|support)\b)`;
/**
 * Where only a recipient collects a parcel. Parcel shops, service points and
 * access points also take in the drop-offs a courier then collects ("Picked
 * up at parcelshop", "collected from the ServicePoint"), so a collection there
 * has to name the recipient.
 */
const COLLECTION_PLACE = String.raw`(?:pick ?up (?:point|station|parcel ?shop|locker)|collection point|(?:parcel )?lockers?|packstation|(?:post office |postal )?counter)\b`;
const COLLECTED = String.raw`(?:picked up|collected)`;
/**
 * A parcel collected from its pickup point: by the recipient, the consignee or
 * the customer, or from a pickup point, locker or counter, in each language.
 */
const RECIPIENT_COLLECTED = new RegExp([
  String.raw`\b${COLLECTED}(?: [\w'-]+){0,6}? by (?:the |a |an |its |your )?${RECIPIENT}|\b${RECIPIENT} (?:has |have )?(?:already )?${COLLECTED}\b|\b${COLLECTED} (?:from|at|in) (?:the |a |an |its |your |our )?(?:[\w-]+ ){0,2}?${COLLECTION_PLACE}`,
  String.raw`\bretire(?:e|s|es)?\b${SENTENCE}*? par (?:le |la |l'|son |sa )?(?:destinataire|cliente?)\b|\b(?:destinataire|cliente?) a retire\b|\bretire(?:e|s|es)? (?:au |en |dans (?:le |la |l'|un |une |votre |son )|a la |a l')(?:point (?:de )?retrait|point relais|relais|consigne|locker|bureau de poste)\b`,
  String.raw`\b(?:vom|von (?:der|dem)|durch (?:den|die)) (?:empfanger(?:in)?|kunden|kundin|adressaten|adressatin)\b${SENTENCE}*?\babgeholt\b|\b(?:empfanger(?:in)?|kunde|kundin) hat\b${SENTENCE}*?\babgeholt\b|\b(?:in|aus) (?:der|dem|einer|einem|ihrer|ihrem) (?:[\w-]+ )?(?:filiale|postfiliale|packstation|paketstation|abholstation|postamt)\b${SENTENCE}*?\babgeholt\b`,
  String.raw`\britirat[oaie]\b${SENTENCE}*? dal(?:la)? (?:destinatari[oa]|cliente)\b|\b(?:destinatari[oa]|cliente) ha ritirato\b|\britirat[oaie] (?:presso|in|al|nel|nella) (?:il |la |lo |l')?(?:punto (?:di )?ritiro|locker|ufficio postale)\b`,
  String.raw`\b(?:recogid|retirad)[oa]s? por (?:el |la )?destinatari[oa]\b|\bdestinatari[oa] (?:ya )?ha (?:recogido|retirado)\b|\b(?:levantad|retirad)[oa]s? pel[oa] destinatari[oa]\b|\bodebran[aeoy] przez (?:odbiorce|adresata)\b`,
].join('|'));
const COLLECT_VERB = String.raw`(?:picked up|collected|retire|abgeholt|ritirat|recogid|retirad|levantad|odebran)`;
/** A collection negated, still to come or made a condition, in each language. */
const COLLECTION_PENDING = new RegExp(String.raw`(?:\b(?:not|never|nothing|non|pas|jamais|nicht|nao|nie)\b|n't)${SENTENCE}*?${COLLECT_VERB}|\bno (?:(?:ha|han|fue|sido|se) )*(?:recogid|retirad)|\b(?:be|being|once|when|until|till|if|unless|before|etre|sera|seront|serait|essere|sara|saranno|verra|verranno)(?: [\w']+){0,3}? ${COLLECT_VERB}|\babgeholt (?:werden|wird)\b|\b(?:wird|werden|kann|konnen|muss|soll)\b${SENTENCE}*?\babgeholt\b`);
/** A courier, a driver or the sender's side collecting it, in each language. */
const COLLECTED_BY_CARRIER = new RegExp(String.raw`\b(?:by|from|par|de|du|vom|von|beim|dal|dalla|dallo|por|del|pelo|przez) (?:the |a |an |our |your |le |la |l'|den |der |dem |il |lo |el |o )?(?:[\w-]+ )?(?:couriers?|drivers?|carriers?|senders?|shippers?|sellers?|merchants?|consignors?|chauffeur|livreur|transporteur|coursier|expediteur|\w*(?:fahrer|kurier|zusteller|boten?)|absender|corriere|autista|vettore|mittente|repartidor|mensajero|transportista|remitente|motorista|estafeta|remetente|kuriera|nadawcy)\b(?!')`);
/**
 * A shipment, order or label cancelled, and nothing else in the scan, in each
 * language and Turkish ("İptal Edildi"). A cancelled return, pickup or hold,
 * which lets the parcel go on, is not one.
 */
const CANCELLED = new RegExp(String.raw`^(?:(?:the |your |this )?(?:shipment|parcel|package|order|consignment|item|delivery|(?:shipping )?label|envoi|colis|commande|livraison|sendung|paket|auftrag|bestellung|lieferung|spedizione|pacco|ordine|consegna|envio|paquete|pedido|entrega|encomenda|objeto|przesylka|paczka|zamowienie|gonderi|kargo|siparis) )?(?:(?:has been|was|is|a ete|est|wurde|ist|e stat[oa]|e|ha sido|fue|foi|zostal[ao]?) )?(?:cancell?ed|annulee?s?|storniert|annulliert|annullat[oa]|cancelad[oa]|anulad[oa]|anulowan[aeoy]|iptal edildi)$`);

/**
 * INFERRED language rules, not captured carrier codes. EN/FR/DE/IT/ES/PT/PL equivalents
 * are intuitive and overridable: an adapter must resolve verified codes and
 * carrier-specific semantics before consulting this fallback. No fixture import.
 */
export function trackingLanguageStage(description: string): Stage | undefined {
  const text = comparable(description);

  if (/^wird zugestellt$/.test(text)) return 'out_for_delivery';
  // Every rule below reads only what happened, never a delivery still to come.
  const reported = deliveryForecastRemainder(text);
  if (reported !== undefined) return reported ? trackingLanguageStage(reported) : undefined;

  // Specific negatives, future steps and handoffs precede broad delivery words.
  if (nonterminalEnglishReturn(text)) return 'exception';
  // Spanish and Portuguese returns still under way, announced or negated.
  if (/\b(?:en|em) (?:proceso de |processo de )?devolu(?:cion|cao)\b|^devolu(?:cion|cao)$|\bdevolu(?:cion|cao) (?:en curso|em curso|iniciada|solicitada|en transito|em transito)\b|\bdevolu(?:cion|cao) (?:al|ao|a la|a) (?:remitente|remetente|origen|origem)\b(?! (?:completad|finalizad|concluid|entregad|entregue|realizad|efectuad|efetuad))|\ben camino (?:de vuelta |de regreso )?(?:al|hacia el) remitente\b|\b(?:a caminho (?:de volta )?(?:do|ao)|em transito para o) remetente\b|\b(?:siendo|sendo|a ser) (?:(?:devuelt|devolvid)[oa]s?|entregad[oa]s? al remitente|entregues? ao remetente)\b|\b(?:no|nao) (?:(?:ha|han|se|fue|foi|foram|sido|ser|sera|puede|pode|pudo|podido|todavia|aun|ainda|ya|ja) )*(?:(?:devuelt|devolvid)[oa]s?|entregad[oa]s? al remitente|entregues? ao remetente)\b|\b(?:sera|seran|serao|va a ser|vai ser|puede ser|pode ser|debe ser|deve ser|devera ser) (?:(?:pronto|proximamente|en breve|em breve|brevemente) )?(?:(?:devuelt|devolvid)[oa]s?|entregad[oa]s? al remitente|entregues? ao remetente)\b|\bse (?:le )?devolvera\b/.test(text)) return 'exception';
  if (/returned to (?:the )?sender|retour(?:ne)? a l'expediteur|zuruck an (?:den )?absender|an (?:den )?absender zuruck|retour a l'expediteur|reso al mittente|restituit[oa] al mittente|delivered (?:back )?to (?:the )?(?:sender|shipper)/.test(text)) return 'returned';
  if (/^(?:(?:envio|paquete|pedido|objeto|encomenda|pacote|remessa) )?(?:devuelt|devolvid)[oa]$|\b(?:devuelt|devolvid|retornad)[oa]s? (?:al|ao|a la|a) (?:remitente|remetente|origen|origem)\b|\bentregad[oa]s? al remitente\b|\bentregues? ao remetente\b|\bdevolu(?:cion|cao) (?:(?:al|ao|a la|a) (?:remitente|remetente|origen|origem) )?(?:completad|finalizad|concluid|entregad|entregue|realizad|efectuad|efetuad)/.test(text)) return 'returned';
  // A new attempt announced on its own reschedules the round; with the reason
  // the last one failed ("No payment, new delivery attempt") it stays a failed attempt.
  if (/^(?:a )?(?:new|next|another|further) (?:delivery )?attempt\b/.test(text)
    && !/\b(?:not|unable|fail(?:ed|ure)?|unsuccessful|missed|absent|closed|refused|nobody|no one)\b|n't\b/.test(text)) return 'in_transit';
  if (/not (?:yet )?delivered|\bundelivered\b|could not.*deliver|\bcan(?: ?not|'t) be delivered\b|unable to deliver|delivery (?:attempt|failed)|non livre|n'(?:a|avons) (?:pas )?pu.*(?:remis|remettre)|n'a pas pu etre (?:distribue|livre)|\bne (?:peut|pourra|pourrait|pouvait) (?:pas )?etre (?:distribue|livre)|livraison (?:impossible|echouee)|\bechec (?:de (?:la )?)?livraison|tentative de livraison|nicht zugestellt|nicht zugestellt werden|zustellung.*(?:fehlgeschlagen|nicht moglich)|zustellversuch|non consegnat[oa]|non e stato possibile consegnare|consegna (?:fallita|non riuscita)|tentativo di consegna/.test(text)) return 'failed_attempt';
  if (/\bno (?:(?:ha|han|hemos|se|le|lo|la|fue|sido|ser|es|era|pudo|puede|podido|posible|todavia|aun) )*(?:entregad[oa]s?|entregar(?:lo|la|le|se)?|repartid[oa]s?|realizar la entrega|efectuar la entrega)\b|\bsin entregar\b|\b(?:entrega|reparto) (?:fallid[oa]|imposible|no (?:(?:ha|han|se|fue|sido|ser|pudo|puede|podido) )*(?:realizad[oa]|efectuad[oa]|completad[oa]|posible|conseguid[oa]))\b|\bimposible (?:entregar|realizar la entrega|efectuar la entrega)\b|\bfallo (?:en la|de) entrega\b|\bintento fallido\b|\bintento de (?:entrega|reparto)\b(?! (?:programad|previst|para (?:hoy|manana|el)|manana|hoy))|\bnao (?:(?:foi|foram|ser|sera|pode|podemos|conseguimos|conseguiu|se|possivel|e|ainda|tem sido|esta|estava) )*(?:entregues?|entregar|efetuar a entrega|efectuar a entrega|realizar a entrega)\b|\bentrega (?:falhada|sem sucesso|impossivel|nao (?:(?:foi|pode|ser|sera|tem sido) )*(?:efetuada|efectuada|realizada|conseguida|concretizada|possivel))\b|\bfalha (?:na|de) entrega\b|\btentativa (?:de entrega|sem sucesso)\b(?! (?:agendada|prevista|programada|para (?:hoje|amanha)|amanha|hoje))|\bcarteiro nao atendido\b/.test(text)) return 'failed_attempt';
  // Missed rounds worded around the attempt, the absent recipient or a closed
  // business. A scheduled attempt is not a missed one, nor is a sender pickup.
  if (!/\bpick ?up (?:attempt|was attempted|unsuccessful|failed)|attempted (?:to )?pick ?up/.test(text)
    && /(?:attempted|tried) to deliver|\bwe(?: have|'ve)? missed (?:you|each other)\b(?![^.;!?]*\bready for (?:pickup|collection)\b)|\battempted delivery\b(?! (?:is )?(?:scheduled|planned|expected|tomorrow|will)\b)|unsuccessful delivery|delivery (?:was )?unsuccessful|unable to complete (?:the |your |this )?delivery|(?<!\bif (?:the |your )?)\b(?:recipient|addressee|consignee|customer|receiver|user)(?: was| is)? (?:not (?:at home|home|available|present)|unavailable|absent)\b|absence of (?:the )?(?:recipient|addressee|consignee)|\bbusiness (?:was |is )?closed\b|destinataire absent|(?<!\ben cas d')\babsence du destinataire|(?:entreprise|societe) (?:etait |est )?fermee?\b|nicht angetroffen|(?:firma|betrieb|geschaft) (?:war |ist )?geschlossen|destinatario assente|(?:attivita|azienda|ditta) (?:era |e )?chiusa/.test(text)) return 'failed_attempt';
  // The same in Spanish and Portuguese ("Ausente"), where "recogida" and
  // "recolha" name the sender pickup and "si"/"caso" make absence a condition.
  if (!/\bintento de recogida\b|\brecogida (?:fallida|no realizada|no efectuada)\b|\btentativa de (?:recolha|coleta)\b|\b(?:recolha|coleta) (?:falhada|sem sucesso|nao (?:realizada|efetuada|efectuada))\b/.test(text)
    && !/\b(?:si|caso)\b[^.;:]*\b(?:ausen|nadie|ninguem|cerrad|fechad|no (?:esta|se encuentra)|nao (?:esta|se encontra))|\bse (?:o |a )?(?:destinatari[oa] |cliente )?(?:estiver|for|nao estiver)\b/.test(text)
    && /\bausen(?:te|tes|cia)\b|\b(?:destinatari[oa]|cliente|consignatari[oa]) (?:no (?:esta|estaba|se encuentra|se encontraba|disponible|presente)|nao (?:esta|estava|se encontra|se encontrava|disponivel|presente))\b|\bnadie en (?:casa|el domicilio)\b|\bninguem em casa\b|\b(?:establecimiento|negocio|empresa|comercio|tienda) (?:esta |estaba |se encontraba )?cerrad[oa]\b|\b(?:estabelecimento|empresa|loja|comercio|negocio) (?:esta |estava |se encontrava )?fechad[oa]\b/.test(text)) return 'failed_attempt';

  // A hold the recipient asked for is a delivery choice, not a problem: the parcel
  // waits for its new date, or at the counter when the scan names one.
  if (RECIPIENT_HOLD.test(text)) return COUNTER.test(text) ? 'ready_for_pickup' : 'in_transit';
  // Carrier-reported problems that are neither a missed attempt nor a return.
  if (/\b(?:damaged|broken in transit)\b|endommag|avarie|deterior|beschadigt|danneggiat|danad[oa]|danificad|uszkodzon/.test(text)) return 'exception';
  if (/\blost (?:in transit|package|parcel|shipment)?\b|colis perdu|envoi perdu|egare|verloren|verlust der sendung|smarrit|(?:paquete|envio) perdid|extraviad|zagubion|zaginion/.test(text)) return 'exception';
  if (/refused by (?:the )?(?:recipient|consignee)|\brefused\b|rejected by (?:the )?recipient|refus(?:e|ee)? par le destinataire|refus du destinataire|(?:colis|envoi|pli) refuse|annahme verweigert|verweigert|rifiutat|rechazad|recusad|odmowa przyjecia|odmowiono przyjecia/.test(text)) return 'exception';
  if (/address (?:incomplete|incorrect|invalid|insufficient|unknown)|(?:incorrect|incomplete|insufficient|wrong|invalid) address|(?:updated|correct(?:ed)?|complete) (?:delivery )?address (?:is )?(?:required|needed)|address(?:ee)? (?:unknown|cannot be located)|recipient unknown|adresse (?:incorrecte|incomplete|erronee|invalide|inconnue)|destinataire inconnu|(?:adresse|anschrift) (?:unvollstandig|falsch|unbekannt)|empfanger unbekannt|indirizzo (?:errato|incompleto|insufficiente|sconosciuto)|destinatario sconosciuto|direccion (?:incorrecta|incompleta|erronea|desconocida)|destinatario desconocido|endereco (?:incorreto|incompleto|errado|desconhecido)|destinatario desconhecido|adres (?:niepelny|nieprawidlowy|bledny)|nieznany adresat/.test(text)) return 'exception';
  if (CUSTOMS_PROBLEM_ENDED.test(text)) return 'in_transit';
  // A customs problem is an exception; a customs hold is customs at work.
  if (/customs (?:issue|problem)|probleme de douane|zollproblem|problema doganale|problema de aduana|problema (?:alfandegario|na alfandega)|problem celny/.test(text)) return 'exception';
  if (CUSTOMS_HOLD.test(text)) return 'customs';
  if (/(?:shipment|parcel|package) (?:is )?(?:held|blocked|on hold)|held pending|awaiting (?:your )?instructions|action required|(?:colis|envoi|pli) (?:bloque|retenu)|en attente d'instructions|action requise|sendung (?:blockiert|zuruckgehalten|angehalten)|wartet auf anweisungen|handlung erforderlich|spedizione (?:bloccata|trattenuta)|in attesa di istruzioni|envio (?:bloqueado|retenido)|en espera de instrucciones|accion requerida|encomenda (?:bloqueada|retida)|aguarda instrucoes|acao necessaria|przesylka (?:zatrzymana|wstrzymana)|oczekuje na instrukcje/.test(text)) return 'exception';
  if (/\bincident\b|\banomal(?:y|ie|ia)\b|delivery exception|shipment exception|irregularit|unregelmassigkeit|storung|vorfall|inconveniente|incidencia|nieprawidlowosc/.test(text)) return 'exception';
  // Carriers' own codes file a cancellation as an exception (17TRACK's
  // Exception_Cancel, Delhivery, Ninja Van, FedEx): it will not be delivered.
  if (CANCELLED.test(text)) return 'exception';

  // Sender data, not the parcel: "Shipment recorded by sender (data delivered)".
  if (/\b(?:data|information|details) delivered\b|\bdaten (?:ubermittelt|erhalten)|donnees (?:transmises|recues)/.test(text)) return 'registered';
  if (/\b(?:datos|informacion|dados|informacao|informacoes) (?:del envio |do envio |da encomenda )?(?:entregad[oa]s?|entregues?)\b/.test(text)) return 'registered';
  // Left for the carrier to admit, not admitted yet: Correos's "Depositado para
  // admisión", a parcel the sender dropped in a CityPaq locker.
  if (/\bpara (?:su )?(?:admision|admissao)\b|\b(?:deposited|dropped off)\b(?: [\w']+){0,8}? for (?:admission|acceptance)\b/.test(text)) return 'registered';
  // The recipient collecting the parcel ends the delivery, ahead of the drop-off
  // at the pickup point the scan may also name; the courier's or the sender's
  // collection is an acceptance below.
  if (RECIPIENT_COLLECTED.test(text) && !COLLECTION_PENDING.test(text) && !COLLECTED_BY_CARRIER.test(text)) return 'delivered';
  // "Delivered to" a pickup point or an intermediary is not delivery to the
  // recipient; a parcel already waiting at its pickup point outranks the
  // "sera remis" (will be handed over) that follows in La Poste's sentence.
  if (/delivered (?:to|at|in(?:to)?) [^.;,]*?(?:pick ?up (?:point|location)|parcel ?shop|access point|packstation|parcel locker|relay point|service point|collection point)|livre (?:au|en|dans (?:le|un|votre)) (?:point (?:de )?retrait|point relais|relais|consigne|locker)|(?:est|colis|envoi) disponible (?:dans|au|en) (?:votre |le |un )?(?:point (?:de )?retrait|point relais|relais|consigne|bureau de poste)/.test(text)) return 'ready_for_pickup';
  if (/(?<!\b(?:sera|seran|serao|ser|sea|seja|for|siendo|sendo) )\bentregad[oa]s? (?:en|a|al) (?:el |la |un |una |su |tu )?(?:punto (?:de )?(?:recogida|conveniencia)|punto (?:pack|celeritas|collectt|nacex|inpost|dpd|gls|seur|mrw|ups|correos)|locker|taquilla|consigna|citypaq|parcel ?shop|buzon inteligente)\b|(?<!\b(?:sera|serao|ser|seja|for|sendo) )\bentregues? (?:no|num|na|numa|em|ao|a) (?:ponto (?:de )?(?:recolha|levantamento|pickup|entrega)|ponto (?:ctt|dpd|gls|inpost|ups|payshop)|cacifo|locker|loja ctt|payshop)\b/.test(text)) return 'ready_for_pickup';
  if (/delivered to (?:the |a |an |our )?(?:local |destination |final |next |onward |last mile )?(?:carrier|courier|airline|air carrier|hub|depot|terminal|forwarder|(?:handling )?agent|(?:logistics|transport(?:ation)?|shipping|delivery|courier) (?:company|provider|partner|agent|service)|sorting (?:center|centre|facility)|(?:processing |distribution |transit |delivery |logistics )?(?:center|centre|facility)|post office(?! box)|postal (?:operator|service|office)|destination country)\b|delivered to (?:the )?(?:\w+ )?(?:post|poste|posta)\b(?! box| office box)|delivered to (?:dhl|dpd|gls|ups|fedex|usps|tnt|hermes|evri|colissimo|chronopost|quickpac|planzer)\b|handed (?:over )?to (?:the |a |an |our )?(?:local |last mile )?delivery partner|en cours de livraison (?:au|en|vers (?:le|un|votre)) (?:point (?:de )?retrait|point relais|relais|consigne)|livre au transporteur|remis au transporteur local|an den lokalen zusteller ubergeben|consegnat[oa] al (?:corriere|vettore|trasportatore)/.test(text)) return 'in_transit';
  if (/(?<!\b(?:sera|seran|ser|sea|for) )\bentregad[oa]s? (?:(?:el|su|tu) (?:paquete|envio|pedido|bulto) )?(?:a|al|en) (?:el |la |un |una |nuestr[oa] )?(?:transportista|agencia (?:de )?(?:transporte|colaboradora|destino|origen)|operador(?: postal| logistico)?|mensajer(?:o|ia)|courier|empresa de (?:transporte|mensajeria|paqueteria)|compania (?:aerea|de transporte)|aerolinea|centro (?:de )?(?:clasificacion|distribucion|tratamiento|logistico|operaciones)|almacen|delegacion|plataforma|hub|correos|seur|mrw|nacex|tipsa|ctt|gls|dhl|dpd|ups|fedex|tnt|envialia|zeleris|paack|celeritas|inpost)\b|\bentregad[oa] por el remitente\b|(?<!\b(?:sera|serao|ser|seja|for) )\bentregues? (?:(?:a|o) (?:encomenda|envio|objeto) )?(?:a|ao|aos|as|na|no|nos|em) (?:transportadora|transportador|operador(?: postal| logistico)?|parceiro|companhia aerea|centro (?:de )?(?:distribuicao|tratamento|triagem|operacional|logistico)|armazem|plataforma|hub|ctt|correios|dpd|gls|dhl|ups|fedex|tnt|seur|mrw|nacex|tipsa|inpost)\b|\bentregue pelo remetente\b/.test(text)) return 'in_transit';
  if (/will (?:shortly |soon )?be handed|bientot.*(?:confie|remis)|prochainement.*remis|wird.*(?:kurze|bald).*ubergeben|sara.*(?:breve|presto).*affidat/.test(text)) return 'registered';
  // The sender still has to hand the parcel over: "Pendiente de entregar a TIPSA".
  if (/\bpendiente de (?:entregar|entrega|recepcion|admision|recibir) (?:a|al|en|por) (?:la |el )?(?:agencia|transportista|operador|correos|seur|mrw|nacex|tipsa|ctt|gls|dhl|dpd|ups|fedex|envialia|zeleris|paack|inpost|celeritas)\b|\bpendiente de (?:recepcion|admision)\b|\baguarda entrada\b|\bpendente de (?:rececao|recepcao|entrada)\b/.test(text)) return 'registered';
  if (/or awaiting processing|ou en attente de traitement|oder wartet auf.*bearbeitung|o in attesa di elaborazione/.test(text)) return 'registered';
  if (/will be transported|sera (?:transporte|achemine)|wird.*transportiert|sara trasportat/.test(text)) return 'in_transit';
  if (/will be available|sera disponible|(?:sera|va etre|doit etre) (?:distribue|remis|mis en (?:livraison|distribution))|wird.*verfugbar|sara disponibile|to be delivered|a livrer|noch zuzustellen|da consegnare|(?:once|when|as soon as) (?:the |your )?(?:shipment|parcel|package|item) is out for delivery/.test(text)) return 'in_transit';
  if (/\bestara disponi(?:ble|vel)\b|\bpor entregar\b|\bpendiente de (?:entrega|entregar|reparto)\b|\bpendente de entrega\b|\b(?:aguarda|aguardando|a aguardar) (?:a )?entrega\b|\bsera (?:enviad|transportad|expedid|encaminhad)[oa]s?\b/.test(text)) return 'in_transit';

  if (/ready for (?:pickup|collection)|ready to collect|ready to be (?:picked up|collected)\b(?! (?:by|from) (?:the |a |an |our |your )?(?:courier|carrier|driver|sender|shipper|seller|merchant|warehouse)\b)|available for (?:pickup|collection)|awaiting (?:customer |recipient |your )?(?:pickup|collection)|pret.*(?:retrait|retire)|disponible.*(?:retrait|collecte)|vous attend (?:au|en|dans|chez|a)\b|mise? a disposition (?:au|en|dans|a)\b.*(?:point (?:de )?retrait|relais|consigne|locker|bureau de poste|agence)|jours? restants? pour (?:le )?retirer|abholbereit|zur abholung bereit|pront[oa] per il ritiro|disponibile per il ritiro|(?:deposited|depose|hinterlegt|depositat[oa]).*mypost24/.test(text)) return 'ready_for_pickup';
  if (/(?<!\b(?:no|nao|ya no|ja nao) (?:(?:esta|estara|se encuentra|se encontra|e|era|foi) )?)\bdisponi(?:ble|vel) (?:para (?:su |ser )?(?:recoger|recogida|recogid[oa]|retirar|retiro|retirada|retirad[oa]|levantamento|levantar|levantad[oa]|recolha|recolher)|(?:en|no|na|num|numa|em) (?:el |la |un |una |su |tu |nuestr[oa] )?(?:punto|oficina|tienda|locker|taquilla|consigna|citypaq|parcel ?shop|buzon inteligente|agencia|delegacion|sucursal|ponto|loja|cacifo|estacao|balcao|payshop|posto|unidade))\b|\blist[oa] para (?:su |ser )?(?:recoger|recogida|recogid[oa]|retirar|retiro)\b|\bpront[oa] (?:para|a) (?:ser )?(?:levantamento|levantar|levantad[oa]|recolha|recolher|retirada|retirar)\b|\b(?:ya )?(?:puede|puedes|podra|podras) (?:pasar a )?recoger(?:lo|la)?\b|\b(?:aguarda|aguardando|a aguardar) (?:o |a )?(?:levantamento|retirada)\b|\besperando (?:su|tu) recogida\b|\b(?:pendiente de|esperando|a la espera de) (?:ser )?recogid[oa] por (?:el |la )?destinatari[oa]\b/.test(text)) return 'ready_for_pickup';

  // Pre-advice can contain "data delivered", a recipient or a carrier handoff.
  if (/label (?:created|printed)|(?:created|generated) a (?:new )?(?:shipment |shipping )?label|etiquette.*(?:cree|imprime)|cree une etiquette|versandetikett.*(?:erstellt|gedruckt)|etikett erstellt|etichetta.*(?:creata|stampata)|creato un'etichetta|elektronisch|electroni(?:c|que|sch)|elettronic|pre.?advi[cs]|preannunciat|vorangemeldet|preannonce|data.*entered|donnees.*saisies|daten.*erfasst|dati.*inseriti|\bpre ?(?:registered|registration|registr?ad[oa]s?|registrat[oa]|enregistree?s?)\b|\bprerregistr(?:ad[oa]s?|o)\b|\bvorregistriert\b|\bwstepnie zarejestrowan[aey]\b/.test(text)) return 'registered';
  if (/\border (?:details|information|info|data) (?:(?:has|have) been |was |were )?(?:received|submitted|transmitted)\b|\breceived (?:your |the )?order (?:details|information|data)\b|\b(?:details|informations|donnees) de (?:la |votre )?commande (?:ont ete )?(?:recu|transmis)e?s?\b|\b(?:auftrags|bestell)daten (?:wurden |sind )?(?:erhalten|ubermittelt|eingegangen)\b|\b(?:dati|dettagli) (?:dell'ordine|ordine) (?:sono stati )?ricevuti\b|\b(?:datos|detalles|informacion) del pedido (?:han sido |fueron )?recibid[oa]s?\b|\b(?:dados|detalhes|informacoes?) d[oa] (?:pedido|encomenda) (?:foram )?recebid[oa]s?\b|\bdane zamowienia (?:zostaly )?(?:otrzymane|przyjete)\b|\botrzymano dane zamowienia\b/.test(text)) return 'registered';
  if (/shipment information (?:received|sent to)|\bdata received\b|(?:package|parcel|shipment) data (?:was |has been )?sent to|\bpre ?notification\b|informations d'expedition recues|sendungsinformationen erhalten|informazioni.*spedizione ricevute|(?:consignment|shipment|parcel|package) recorded by|envoi enregistre par|sendung.*absender.*erfasst|spedizione registrata dal/.test(text)) return 'registered';
  if (/preparation chez.*expediteur|preparation.*expediteur|preparazione.*mittente|being prepared.*sender|(?:shipper|sender)(?: that)? (?:they are|is|are) preparing|beim absender.*vorbereitet|warehouse of the sender|shippers warehouse|entrepot de l'expediteur|lager des absenders|magazzino del mittente|demande d'envoi.*prise en compte|collection request.*(?:received|recorded)|abholauftrag.*erfasst|richiesta.*ritiro.*registrata/.test(text)) return 'registered';
  // The carrier has not had the parcel yet: "Shipment not yet received or
  // processed". What else the scan reports still counts: "Arrived at hub; not
  // yet processed" is in transit, and a clearance delay stays with customs.
  if (!/\b(?:at|in|by) (?:the )?(?:destination|delivery|recipient|consignee|addressee|customer|customs|office of exchange)\b/.test(text)) {
    const rest = text.replace(NOT_YET, ' ');
    if (rest !== text) return trackingLanguageStage(rest.replace(/^[\s,;:.!?]+|[\s,;:]+$/g, '')) ?? 'registered';
  }
  if (/^(?:reported|recorded|announced|item created|enregistre|annonce|erfasst|angekundigt|registrato|annunciato)$/.test(text)) return 'registered';
  // A shipment record the sender created ("Shipment created"), and nothing else.
  if (/^(?:(?:the |your |a |new )?(?:shipment|parcel|package|consignment|order|envoi|colis|expedition|commande|sendung|paket|auftrag|spedizione|pacco|ordine|envio|paquete|pedido|encomenda|przesylka|paczka|zamowienie|gonderi|kargo|siparis) )(?:(?:has been|was|a ete|wurde|e stat[oa]|ha sido|fue|foi|zostal[ao]?) )?(?:created|creee?s?|erstellt|angelegt|creat[oa]|cread[oa]|criad[oa]|utworzon[aey]|olusturuldu)$/.test(text)) return 'registered';

  // A completed clearance or release moves the parcel on; holds, inspections,
  // submissions and clearance still pending or negated stay with customs.
  if (CUSTOMS_PENDING.test(text)) return 'customs';
  if (CUSTOMS_RELEASED.test(text)) return 'in_transit';
  if (/customs|clearance|douan|formalites (?:d')?(?:import|export)|zoll|dogan|\b(?:des)?aduan[ae]|alfandeg|\bceln|government agency|autorite gouvernementale|staatliche behorde|autorita governativa/.test(text)) return 'customs';

  if (/out for (?:physical )?delivery|\bout with (?:the |a |our |your )?(?:delivery )?(?:courier|driver)s?\b(?! for (?:pick ?up|collection|return))|being delivered|in delivery|(?:loading|loaded).*delivery vehicle|on (?:\w+ )?vehicle for delivery|(?:courier|driver|delivery champion) has (?:the|your) (?:shipment|parcel|package|item)|en cours de livraison|en livraison|de la livraison de (?:son|votre) colis ce jour|charg(?:e|ement).*vehicule de livraison|in zustellung|zustellfahrzeug.*(?:geladen|verladen)|(?:beladen|verladung).*zustellfahrzeug|in consegna|caric(?:at|amento).*veicolo.*consegna/.test(text)) return 'out_for_delivery';
  // "Reparto" alone is the round, but not the "unidad de reparto" it leaves from;
  // "distribuição" is the round, but not the "centro de distribuição".
  if (/^(?:en )?reparto$|\ben reparto\b|\b(?:siendo|sendo|a ser) (?:entregad[oa]s?|entregues?|repartid[oa]s?|distribuid[oa]s?)\b|\b(?:salida|salio|sale|ha salido) (?:a|para) (?:el )?reparto\b|\bruta de (?:reparto|entrega)\b|\ben proceso de entrega\b|\bvehiculo de reparto\b|\b(?:repartidor|mensajero|cartero|conductor) (?:ya )?(?:tiene|lleva) (?:tu|su|el|la) (?:paquete|envio|pedido|encomienda)\b|\bem distribuicao\b|\bsaiu para (?:a )?(?:entrega|distribuicao)\b|\bem (?:rota|processo|curso) de entrega\b|\bem entrega\b|\bveiculo de (?:entrega|distribuicao)\b|\b(?:carteiro|estafeta|motorista|entregador) (?:ja )?(?:tem|leva) (?:a|o) (?:sua |tua )?(?:encomenda|envio|objeto|pacote|volume)\b/.test(text)) return 'out_for_delivery';
  // Handed to the courier alone is the delivery round, as DHL eCommerce NL and
  // YunExpress file it, unless the scan names a pickup, a return or the sender.
  if (HANDED_TO_COURIER.test(text) && !/\b(?:pick ?up|collection|return|sender|shipper|seller|merchant|consignor)/.test(text)) return 'out_for_delivery';
  if (/\bdelivered\b|^final delivery$|delivery complete(?:d)?\b|delivery (?:was )?successful|(?:a ete|est) distribue|^(?:livre|livree)(?:$|[ ,])|(?:colis|envoi|est|a ete) livre|zugestellt|\bconsegnat[oa]\b|livraison effectuee|consegna completata/.test(text)) return 'delivered';
  // A delivery still to come ("una vez entregado", "que se entregue", "quando
  // for entregue") is not one; Spanish "entregue" is also a subjunctive.
  if (!/\b(?:una vez|cuando|hasta que|antes de que|para que|en cuanto|tan pronto como|uma vez|quando|assim que|ate que|logo que)\b[^.;:]*\bentreg/.test(text)
    && /(?<!\b(?:sea|sean|fuera|fuese|ser|seja|sejam|fosse|for|forem|que|se) )\b(?:entregad[oa]s?|entregues?)\b|\bentrega (?:realizada|efectuada|efetuada|completada|concluida|finalizada)\b/.test(text)) return 'delivered';

  // A handover to another network, a carrier or a courier set apart, takes the parcel on.
  if (HANDED_TO_NETWORK.test(text)) return 'in_transit';
  // Posting/collection by the carrier, not recipient pickup or data submission.
  if (/^(?:the |your )?(?:item|package|parcel|shipment) (?:has been |was |is )?(?:received for transport|dropped off by (?:the )?sender at (?:our |the )?postal partner)\b/.test(text)) return 'accepted';
  // A vehicle load and a gateway scan prove handling, but do not name the delivery round.
  if (/^(?:load vehicle|scan ok gateway)$/.test(text)
    || /^(?:the )?item in process in office of exchange\b/.test(text)) return 'in_transit';
  if (/^(?:posting\/collection|posted|origin scan)$|received at (?:our |the )?(?:[a-z]+ )?origin (?:office|facility|hub)|dropped off (?:after|before) (?:the )?latest drop ?off time/.test(text)) return 'accepted';
  if (/accepted|picked up|pick up was successful|^drop off$|pick ?up scan|prepared the package for return to ups or pickup by ups|handed (?:over )?to (?:dpd|gls)|package received at dhl|item booked|consignment was mailed|posted at a postal point|pris en charge|prise en charge|collecte.*(?:reussi|effectue)|recupere.*boite aux lettres|depose.*point postal|remis a (?:dpd|gls)|envoi.*depose|abholung.*erfolgreich|eingeliefert|an (?:dpd|gls) ubergeben|paket.*(?:angenommen|ubernommen)|ritiro.*(?:riuscito|effettuato)|pres[oa] in carico|affidat[oa] a (?:dpd|gls)|depositat.*punto postale|spedizione.*impostata/.test(text)) return 'accepted';
  // Admitted by the carrier: Correos's "Admitido", Correos Express's "Admitido en
  // oficina". Admission still to come is registered above.
  if (/(?<!\b(?:no|nao) )\badmitid[oa]s?\b|\badmision en origen\b/.test(text)) return 'accepted';
  // A linehaul is the trunk haul between hubs, whatever was handed over.
  if (/transit|\bline ?haul\b|en route|on (?:its|the) way|\bfacility\b|airport|\bleaving\b|\bdispatched\b|^delay(?:ed)?$|received by (?:the )?(?:local )?(?:delivery|logistics) company|received by postnl|notification.*sent to the recipient|delivery option requested|instruction de livraison recue|expedie (?:depuis|du|de)\b|acheminement|unterwegs|transport|trasport|arriv|depart|processed|processing completed|sorted|sorting|\btri\b|trie|traitement|traite|sortier|bearbeitet|bearbeitung|elaborat|elaborazion|smistat|parcel cent(?:er|re)|delivery cent(?:er|re)|centre.*(?:colis|distribution)|paketzentrum|verteilzentrum|centro.*(?:pacchi|distribuzione)|depot|import scan|scan.*import|importscan|scansione.*import|delivery.*delayed|livraison.*(?:retard|report)|zustellung.*verzogert|consegna.*ritard|transferred|transfere|weitergeleitet|inoltrato|left.*(?:point|center)|quitte|verlassen|raggiunto|close bag|fermeture du sac|sack.*geschlossen|chiusura.*sacco|scanned into|scanne dans|eingescannt|scansionat|\bloaded\b|^(?:item|parcel|shipment) distributed$|charg.*vehicule de transport|transportfahrzeug.*geladen|caric.*veicolo.*trasporto/.test(text)) return 'in_transit';
  if (/^enviad[oa]$|\bclasificad[oa]s?\b|\bclasificacion\b|\ben ruta\b|\ben camino\b|\bllegad[oa]s? (?:a|al|en)\b|\bllegada (?:a|al|en|de)\b|\bha llegado\b|\bllego (?:a|al)\b|\bsalida (?:de|del|desde)\b|\b(?:ha )?salido (?:de|del)\b|\bsalio (?:de|del)\b|\ben destino\b|\b(?:agencia|delegacion|plataforma|oficina|franquicia) (?:de )?destino\b|\b(?:unidad|centro|oficina|delegacion|base|agencia|plataforma) de reparto\b|\bcentro (?:de )?(?:clasificacion|distribucion|tratamiento|logistico|operaciones|operativo)\b|\blectura\b|\bleid[oa]s?\b|\brecepcionad[oa]s?\b|\bprocesad[oa]s?\b|\bexpedid[oa]s?\b|\btriagem\b|\btriad[oa]s?\b|\bem tratamento\b|\btratad[oa]s?\b|\bcentro (?:de )?(?:distribuicao|tratamento|triagem|operacional)\b|\bchegad[ao] (?:a|ao|no|na|em)\b|\bchegou (?:a|ao|no|na|em)\b|\bsaida (?:do|da|de|dos|das)\b|\bsaiu (?:do|da|de|dos|das)\b|\bem rota\b|\ba caminho\b|\bencaminhad[oa]s?\b|\b(?:em )?transferencia\b|\btransferid[oa]s?\b|\bprocessad[oa]s?\b|\brecebid[oa] (?:no|na|em) (?:centro|armazem|unidade|plataforma)\b|\brecibid[oa] en (?:el |la |nuestr[oa] )?(?:almacen|centro|delegacion|plataforma|hub|agencia)\b/.test(text)) return 'in_transit';
  return undefined;
}

export function languageStageStatus(stage: Stage): CarrierStatus {
  if (stage === 'registered' || stage === 'pending') return 'pending';
  if (stage === 'delivered') return 'delivered';
  if (stage === 'out_for_delivery' || stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'returned' || stage === 'failed_attempt' || stage === 'exception') return 'exception';
  return 'in_transit';
}
