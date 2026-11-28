/**
 * Whether a scan's wording or place names what lets someone other than the recipient collect
 * the parcel or find its door: a PIN, a one-time password or passcode, an access, pickup,
 * delivery or verification code, a door or house number, a signature or the person who signed. A host can hide such a scan where people other
 * than the parcel's owner read the history, as a shared link's viewers do.
 *
 * Raw text, so accented and plain spellings are both listed, and Chinese labels in simplified and
 * traditional characters (取件码, 取件碼). A carrier receiving the
 * parcel ("Recibido por Estafeta") and German "Firma" (a business) are not private.
 */
export function hasPrivateDeliveryDetails(description: string): boolean {
  return /\bpin\s*:|\b(?:pin|otp)\s*(?:is\s*)?[=#-]?\s*\d|\botp\b|one[- ]time (?:password|passcode|code|pin)|pass ?code|(?:access|security|pickup|collection|delivery|verification|secret|locker|unlock|retrieval) code|取件[码碼]|取[货貨][码碼]|提[货貨][码碼]|提件[码碼]|取件密[码碼]|[验驗][证證][码碼]|[开開]箱[码碼]|code (?:secret|de livraison|de v[ée]rification|confidentiel)|(?:teslimat|do[gğ]rulama|teslim) kodu|kode (?:verifikasi|pengambilan|ambil)|codice (?:di )?(?:sblocco|verifica|segreto)|c[oó]digo de (?:verificaci[oó]n|verifica[cç][aã]o|confirmaci[oó]n)|(?:door|house) (?:no\b|number)|bezorgd\s*[-–—]\s*ontvangen door\b|signed (?:for )?by|signature|numero civico|firmato da|signe par|signé par|code (?:de retrait|d['’]acc[eè]s)|num[eé]ro de (?:rue|maison)|abholcode|zugangscode|hausnummer|unterschrieben von|codice (?:di ritiro|di accesso)|c[oó]digo (?:pin|secreto|de (?:recogida|retirada|retiro|acceso|acesso|entrega|seguridad|seguran[cç]a|levantamento|recolha|desbloqueo|desbloqueio|apertura|abertura))|firmad[oa] por|firma del destinatari|assinad[oa] por|assinatura|n[uú]mero (?:de (?:portal|puerta|casa|piso|vivienda|pol[ií]cia)|da (?:porta|casa))|(?:porta|puerta) n\.?\s?[º°]|n\.?\s?[º°] (?:de |da )?porta|\bporte\s+(?:n[º°.]?\s*)?\d{1,4}\b|\besc(?:alier)?\.?\s+\d{1,3}\b/i.test(description);
}
