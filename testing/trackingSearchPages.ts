import type { CarrierId } from '../generated/catalog.js';

/**
 * The fields a search page may show, in any frame and open shadow root. Tag
 * widgets such as Tagify (SkyEx) hide their text area under an editable text box,
 * and Patuen's tracker takes numbers in an editable box with a placeholder.
 * On phones CodeMirror edits its lines in place, so RTB56 trackers (GoWorld
 * Express) hide their text area behind its editable code box.
 */
export const FIELD_SELECTOR = 'input, textarea, '
  + ':is([contenteditable][role="textbox"], [contenteditable][placeholder], .CodeMirror-code[contenteditable])'
  + ':not([contenteditable="false"])';

/**
 * Counts the visible, enabled fields that are neither a sign-in field nor the
 * site's own search. It runs in the page, so it uses nothing from outside its
 * body. An input's type is read from the element, which treats an empty or
 * misspelled type (17TRACK, STO) as text.
 */
export function countNumberFields(elements: Element[]): number {
  return elements.filter((element) => {
    const field = element as HTMLInputElement;
    // Japan Post's phone page types its number field as a URL.
    if (field.tagName === 'INPUT' && !/^(?:text|search|tel|number|url)$/.test(field.type)) return false;
    const box = field.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || getComputedStyle(field).visibility === 'hidden' || field.disabled) return false;
    // A text field marked new-password only turns autofill off (Integraa); it is no sign-in clue.
    const autocomplete = field.getAttribute('autocomplete') ?? '';
    const label = [field.name, field.id, field.getAttribute('placeholder'), field.getAttribute('aria-label'),
      /^\s*new-password\s*$/i.test(autocomplete) ? '' : autocomplete].join(' ');
    if (/e-?mail|user ?(?:name|id)|login|password|passwort|mot de passe/i.test(label)) return false;
    const siteSearch = /^(?:q|query|s|search|keywords?)$/i.test(field.name)
      || /^\s*(?:search|rechercher|suchen|buscar|cerca|szukaj)\b/i.test(field.getAttribute('placeholder') || field.getAttribute('aria-label') || '');
    return !siteSearch || /track|suivi|sendung|colis|parcel|package|shipment|waybill|consignment|number|numéro|nummer|número|numero|трек|номер|дугаар|លេខ|运单|運單|单号|單號/i.test(label);
  }).length;
}

/**
 * Carriers that link a parcel but have no public page to type its number in.
 * A parcel whose number is hidden shows no link to them.
 */
export const carriersWithoutSearchPage: Partial<Record<CarrierId, string>> = {
  'amazon-logistics': 'Amazon shows its own deliveries only in the buyer\'s account; no public page takes the number',
  'bft-logistik': 't.bftlogistik.dk opens on a sign-in form; a shipment opens only at its own address',
  blueex: 'blue-ex.com hides its tracking forms on phone-sized screens; its own links open the tracking page with the number',
  ciblex: 'Ciblex shows parcels only in its customer extranet, behind a sign-in',
  'honour-lane-shipping': 'CargoLane opens shipment details from the container number in its address. The corporate tracking page shows an empty tracking frame on phones.',
  hubologistics: 'hubologistics.com has no number field, only its quote and sign-in forms; its enquiry page opens an order only from the number in its address',
  'iran-post': 'post.ir and tracking.post.ir refuse many networks outside Iran; its tracker opens a parcel from the number in its address',
  kargoist: 'kargoist.com\'s tracking page asks for a code sent by text message, and its home page, whose form opened a parcel from the number, shows a maintenance notice',
  'last-one-mile-coop': 'the co-op\'s only tracking form is on y-track.jp and opens only with the co-op\'s form codes in its address; a waybill opens at that address',
  liccardi: 'www.liccarditrasporti.com answers automated browsers with a bot check; its tracker opens a parcel from the number in its address',
  'nim-express': 'nimexpress.com\'s tracking fields are a script widget and a form that asks for a confirmation code; its own header form opens the tracking page with the number',
  'nova-kargo': 'novakargo.com has no tracking form; its Web Postman tracker opens a parcel only from the number in its address',
  pasarex: 'tracking.pasarex.com has no number field and answers "Guía no encontrada" without one; a waybill opens only at its own address',
  pigeonship: 'pigeonship.com has no tracking form; an order opens only at its own address on admin.pigeonship.com, from the recipient\'s link',
  'post-one': 'postone.eu opens a parcel only from the number in its tracking address; its track page shows a sign-in form',
  'redbox-mv': 'redbox.mv/tracking shows no number field; it opens a parcel only from the number in its address',
  rivigo: 'Rivigo\'s public tracker is a hash route on zoom.rivigo.com whose other pages redirect to the staff sign-in; a consignment opens at its own address',
  'skynet-worldwide': 'SkyNet\'s tracker shows its number field only with a network parameter in the address, and skynetworldwide.com has no tracking page of its own',
  torrestir: 'Torrestir hides its number field on phone-sized screens, in a collapsed menu; its Track & Trace button opens the tracker with the number',
  'travel-express': 'the portal\'s tracking number field sits in a visitor card that its own style sheet hides, and its track page asks visitors to sign in; a shipment opens at its own address',
  trumpcard: 'ace2.trumpcardinc.com has no number field and answers "No shipment found" without one; an airbill opens only at its own address',
  trusk: 'track.trusk.com has no search box; an order opens only at its own address',
  xpressen: 'track.xpressen.dk has no number field and answers that it cannot find the shipment without one; a shipment opens only at its own address',
  yimidida: 'www.yimidida.com answers the search-page check with its cloud firewall\'s 405 block page; a waybill opens at its own address',
  'zes-express': 'zes-express.com has no number field; its tracker is a plain-HTTP page on a bare IP address, which the catalog does not link',
};

/**
 * Search pages that show their number field on phones only once controls are tapped: those
 * controls in turn, as Playwright selectors. The check taps the first one shown of each.
 */
export const searchFieldReveals: Partial<Record<CarrierId, readonly string[]>> = {
  'airways-courier-in': ['a.trackBtn'], // the header's track button; before it only the sign-in shows
  'alfa-transportes': ['button:has-text("Rastrear mercadoria")'], // the invoice-number pop-up
  castores: ['.js-tools-label', '#tab-1'], // the header's tools menu, then its Rastrear form
  eurodis: ['text="Tracking by EURODIS shipment number"'], // the collapsed tracking methods
  moovin: ['a[href*="pais=CR"]'], // the country choice; Costa Rica and Honduras share the form
  primewell: ['.burger'], // the menu holds the tracker's voucher box; the page shows only a picture
  'ross-express': ['button:has-text("Ross Pro Number")'], // each kind of number is a collapsed section
  xgs: ['a.track-shipment-activator:has-text("Track a Shipment")'], // the tracking-number pop-up
  zimpost: ['button:has-text("Track")'], // the home page's tracker overlay
};

/**
 * Search pages the weekly check cannot open, and why. Each was seen working in a regular browser,
 * except the sites the catalog opens because their tracker answers plain HTTP only.
 */
export const uncheckedSearchPages: Partial<Record<CarrierId, string>> = {
  '360zebra': 'the tracking page sends the check\'s browser on to the home page, which has no number field; tracking links open the tracker with the number',
  'aaa-cooper': 'www.aaacooper.com refuses connections from many networks; an archived copy of the home page shows its Action Trac number field',
  'act-argos': 'the waybill field on www.argoscom.gr has the id Password, which the check reads as a sign-in field',
  'algerie-poste': 'www.ems.dz answers only Algerian networks; an archived copy shows its tracking code field',
  'aloha-freight': 'the Quick Shipment Search names its field keyword, which the check reads as a site search',
  'ams-egroup': 'the Track & Trace page has no field; its Track Shipment button opens the tracker, which answers plain HTTP only, on port 8084',
  'asyad-express': 'www.asyadexpress.om answers only Omani networks; an archived copy of the page shows its tracking number field',
  'ativa-logistica': 'the home page\'s SSW form, which asks for a CPF or CNPJ rather than a number, opens from its RASTREAMENTO tab, so the check finds no field on load',
  auexpress: 'the Tracking No. box on www.auexpress.com/tracking shows only on desktop-size screens, which the phone-size check does not use',
  azerpost: 'www.azerpost.az does not answer connections from the United States; to European networks it shows its item-number field',
  belpost: 'belpost.by\'s tracking page renders without its number field on the weekly check\'s network; European and American networks get the field',
  'best-express-kh': 'kh.best-inc.com\'s tracker renders only its cookie notice in automated browsers; its address takes the number in bills',
  'best-express-my': 'www.best-inc.my sends phone-sized screens to a tracking page with no waybill field; the desktop page has it',
  'best-express-sg': 'www.best-inc.sg\'s tracker renders only its cookie notice in automated browsers; its address takes the number in bills',
  'best-express-th': 'www.best-inc.co.th\'s tracker renders only its cookie notice in automated browsers; its address takes the number in bills',
  'best-express-vn': 'www.best-inc.vn sends phone-sized screens to a tracking page that renders blank in automated browsers; the desktop page has the waybill field',
  'bluestreak-couriers': 'the client portal keeps its tracking field in a hidden window that its "Quick Track" button opens, so the check finds no field on load',
  btd: 'www.btdair.com has no number field; its tracker answers plain HTTP only, on a bare IP address, which the catalog does not link',
  buslog: 'the tracking page shows its number field only after one of its options (Encomenda, Nota Fiscal or Destinatário) is chosen',
  'cargo-expreso': 'cargoexpreso.com does not answer connections from European and American networks; to a Guatemalan network it shows its waybill number field',
  'chunghwa-post': 'the tracker draws its form only when its menu template loads before its site map, a race a fresh browser often loses; its Track & Trace menu then opens the form',
  'cope-sensitive-freight': 'www.cope.com.au keeps its consignment number field in a hidden pop-up that its "Consignment Tracking" link opens, so the check finds no field on load',
  'cordelia-shipping': 'the BL or container number field on cordelialine.com stays hidden until its "TRACK SHIPMENT" button opens it',
  'correos-cuba': 'www.correos.cu answers only Cuban networks; an archived copy shows its tracking code field',
  cupost: 'www.cupost.co.kr does not answer connections from European and American networks; to a Korean network it shows its waybill number field',
  'custom-companies': 'the Shipment ID box sits in the desktop banner of www.customco.com, which the phone-size check does not show',
  'daylight-transport': 'the Track PRO # field sits in the desktop header of dylt.com, which the phone-size check does not show',
  dellin: 'the tracker answers automated browsers with a Qrator check (HTTP 401); in a regular browser it shows its order-number field',
  deprisa: 'www.deprisa.com answers 403 to networks outside Colombia, the United States, Spain and Argentina; its tracker at /es/rastrea has the number field and checks reCAPTCHA',
  'designer-transport': 'the tracker names its field search, which the check reads as a site search',
  'dpd-by': 'mydpd.dpd.by does not answer connections from the United States; to European networks it shows its order number field',
  'dpd-ru': 'mydpd.dpd.kz does not answer connections from the United States; to European networks it shows its order number field',
  dpdex: 'the number box on client.duopudaexpress.com shows only on desktop-size screens, which the phone-size check does not use',
  dtdc: 'www.dtdc.com refuses connections from many networks outside India; an archived phone-size copy shows its number field',
  'emirates-courier-express': 'the tracking field carries the aria-label "Recipient\'s username", left from a page template, which the check reads as a sign-in field',
  'emirates-post': 'emiratespost.ae answers 403 to many networks outside the UAE; an archived copy shows its number field',
  'esbjerg-gods': 'esbjerg-gods.dk keeps its number fields in a hidden panel that its "Track and Trace" button opens, so the check finds no field on load',
  ezship: 'the tracker shows its shipment-number field only after its 寄件編號 option is clicked',
  'f2-logistics': 'the Track and Trace page has no field; it links the tracker, which answers plain HTTP only, on port 8088',
  'fare-rata': 'espace-client.farerata.pf is a Flutter app that draws its form on a canvas, with no field in the page until one is tapped',
  'fastship-th': 'the tracker names its field search, which the check reads as a site search',
  'fiege-netherlands': 'websped-netherlands.fiege.com answers the United States with a firewall\'s block page; to European networks it shows its search field',
  'first-delivery-tn': 'www.firstdeliverygroup.com answers only Tunisian networks; an archived copy shows its waybill number field',
  fragilepak: 'the Expecting a Delivery page has no field; its "Track Delivery" link opens the tracker on tracking.agentgrid.net, which does not answer European networks',
  'ftd-nz': 'the FTD number field on www.ftd.nz/query/ shows only on desktop-size screens, which the phone-size check does not use',
  gcx: 'info.gcx.co.il, the tracker framed on the page, does not answer connections from outside Israel; an archived copy shows its HAWB number field',
  golucky: 'the number box on www.goluckyvip.com/shipment.html stays folded until its query panel is clicked, so the check finds no field on load',
  goodmaji: 'the tracker names its number box keyword, which the check reads as a site search',
  'grand-slam-express': 'the AWB field on www.grandslamexpress.in/Web/Track is hidden on phone-sized screens, which the check uses; the desktop page shows it',
  'hecny-shipping': 'the tracker names its number box keyword, which the check reads as a site search',
  'hi-trans': 'www.hi-trans.com.au challenges automated browsers; in a regular browser its home page has the consignment number field',
  'high-energy-transport': 'the DispatchTrack page draws its order number field inside a frame, so the page itself holds no field',
  'hr-parcel': 'the tracker names its field q, which the check reads as a site search',
  inntralog: 'the tracking page shows its number field only after its Sendungsnummer or Belegnummer option is chosen',
  'inter-global-kargo': 'the Takip No field on www.globalkargo.com shows only on desktop-size screens, which the phone-size check does not use',
  'intime-bg': 'intime.bg keeps its shipment-number fields in its header search panel and phone menu, both closed on load, so the check finds no field',
  'israel-post': 'israelpost.co.il answers 403 to many networks outside Israel; an archived copy shows its item-number field',
  jcex: 'track.jcex.com\'s CDN refuses connections from Europe, the Americas and most of Asia; reached through the origin server behind it, the page shows its number box',
  'jiaying-express': 'the tracker answers plain HTTP only, on a bare IP address, which the catalog does not link; the help page links to it',
  'kenya-airways-cargo': 'cargotrack.kenya-airways.com is a Flutter app that draws its form on a canvas, with no field in the page until one is tapped',
  'kiwi-express': 'www.kiwiexpress.co.nz keeps its tracking fields in a pop-up and a closed tab panel, so the check finds no field on load',
  kurierzentrale: 'crm.kuz.ch keeps its Sendungsnummer field in a hidden pop-up that its "Track Auftrag" button opens, so the check finds no field on load',
  'kyrgyz-post': 'post.kg answers only Kyrgyz networks; to a Kyrgyz network it shows its track number field',
  'la-poste-tunisienne': 'www.poste.tn does not answer connections from outside Tunisia; an archived copy of its home page shows the item-number field',
  'lm-parcel': 'the number box on www.lmparcel.com/search shows only on desktop-size screens, which the phone-size check does not use',
  'mailplus-au': 'the tracker names its field search, which the check reads as a site search',
  maxzeego: 'the Track Order box on maxzeego.com stays hidden until its "Track Order" button opens it',
  'midland-transport': 'the tracking-number field sits in the desktop navigation bar of the tracker, which the phone-size check does not show',
  'mobel-services': 'the Reference field on tracking.mobelservices.com shows only on desktop-size screens, which the phone-size check does not use',
  'nepal-post': 'pits.gpo.gov.np does not answer connections from outside Nepal; to a Nepali network it shows its item-number field',
  'ocean-network-express': 'the tracker\'s field asks to "Search by BL No. or Booking No.", which the check reads as a site search',
  'olva-courier': 'the tracker names its field q, which the check reads as a site search',
  'ozon-logistics': 'tracking.ozon.ru answers automated browsers with a bot check; in a regular browser it shows the tracking number field',
  'paket-cl': 'track.paket.cl is a Flutter app that draws its form on a canvas, with no field in the page until one is tapped',
  pakettipiste: 'pakettipisteseuranta.r2web.fi does not answer connections from the United States; to European networks it shows its tracking number field',
  paperfly: 'the tracker names its field q, which the check reads as a site search',
  'pavan-courier': 'pavancourierservice.com refuses connections from the United States and France; to Indian and German networks it shows its tracking number field',
  paxel: 'paxel.co answers automated browsers with a Cloudflare block (HTTP 403); in a regular browser its page script fills and submits the AWB field',
  'pink-post': 'trackawb.izzygo.ro does not answer connections from the United States; to European networks it shows its AWB field',
  'polaris-transport': 'polaristransport.com does not answer from many networks; its trace page has the PRO number field',
  'pony-express': 'www.ponyexpress.ru answers 403 to many networks outside Russia; an archived copy shows its waybill field',
  postaplus: 'postaplus.com draws its tracking form late in a script app, after the automated check gives up',
  'runner-express': 'the tracker names its field keywords, which the check reads as a site search',
  'samoa-post': 'the item-number field sits in a ptt.ptc.post frame lower on the home page, which Chromium does not lay out at phone size; the headless shell counts it',
  'seino-super-express': 'the inquiry page shows its waybill fields only after one of its two inquiry methods is chosen',
  'sengi-express': 'portal.sengiexpress.com shows its waybill box only on desktop-size screens, which the phone-size check does not use',
  shippify: 'www.shippify.co keeps its tracking ID field in a hidden pop-up that its "Rastreie seu pedido" link opens, so the check finds no field on load',
  'shunbang-express': 'www.shunbang.vip has no number field; it links trackers that answer plain HTTP only',
  slgtrax: 'sonic.pk drops connections from the weekly check\'s network and some others; to European and other American networks it shows its tracking number field',
  'sofex-post': 'sofexpost.md keeps its tracking box in a hidden pop-up that its "Verifică statutul coletului" button opens, so the check finds no field on load',
  'spee-dee': 'the tracking form is a frame from packages.speedeedelivery.com, which drops connections from many networks',
  'superb-express': 'superb-express.com sends phone-sized screens to its plain-HTTP mobile site, which has no tracking field; the desktop home page has the waybill box',
  'surat-kargo': 'www.suratkargo.com.tr answers a Cloudflare block to many networks outside Turkey; an archived copy shows its number field',
  't-cat': 'www.t-cat.com.tw answers only Taiwanese networks; to a Taiwanese network it shows its waybill number fields',
  'tanto-intim-line': 'www.tantonet.com keeps its container field in a hidden pop-up that its "Tracking" menu link opens, so the check finds no field on load',
  tdn: 'www.tdn.es answers the United States with HTTP 503, and automated browsers often with its firewall\'s notice; Spanish and German networks get its shipment number field',
  'thailand-post': 'some of the tracker\'s servers stall on its script bundles, so the form often stays empty past the render window',
  'the-human-express': 'the tracking field on thehuman.express/trackings shows only on desktop-size screens, which the phone-size check does not use',
  tolos: 'the tracking field carries the aria-label "Recipient\'s username", left from a page template, which the check reads as a sign-in field',
  'topex-logistics': 'www.topex.group has no number field; its tracker answers plain HTTP only, which the catalog does not link',
  topyou: 'the number box on track.szty56.com shows only on desktop-size screens, which the phone-size check does not use',
  toyou: 'the home page\'s Track a parcel box enables its order number field once a retailer is chosen; the tracking page shows "not found" without a number',
  'total-express': 'totalconecta.totalexpress.com.br answers many networks with an Akamai Access Denied page; to the networks it lets through it shows its number field',
  'trans-express-lk': 'tracking.transexpress.lk shows its waybill field only after its DOMESTIC or COD tab is chosen, so the check finds no field on load',
  'trans-o-flex': 'www.trans-o-flex.com answers the burst of script requests its tracking app makes with HTTP 429, so the form often stays empty past the render window',
  'transport-rdl': 'transportrdl.com does not answer the weekly check\'s runners in time, not even a plain request; to other networks it shows its tracking number field',
  treggo: 'the tracking field is named email, which the check reads as a sign-in field',
  'usend-chile': 'the Número de envío field on usend.cl shows only on desktop-size screens, which the phone-size check does not use',
  veloblitz: 'veloblitz.kuz.ch keeps its Sendungsnummer field in a hidden pop-up that its "Track Auftrag" button opens, so the check finds no field on load',
  'velocity-express-in': 'the AWB field on velexp.com/home-tracking shows only on desktop-size screens, which the phone-size check does not use',
  'vip-posta': 'the number field has the id inputEmail3, left from a page template, which the check reads as a sign-in field',
  'vt-freight-express': 'www.vtfe.com.au keeps its consignment field in a pop-up that its "TRACK & TRACE" link opens, and in a header bar that phone-size screens hide',
  'walkers-transport': 'tracking.walkers-transport.co.uk does not answer connections from the United States; to British and German networks it shows its job number field',
  'ward-trucking': 'wardtlctools.com refuses connections from many networks; an archived copy shows its PRO number fields',
  webrinq: 'the tracker names its field q, which the check reads as a site search',
  wiio: 'wiio.com has no number field; its tracker answers plain HTTP only, which the catalog does not link',
  xingyunyi: 'the tracking number field on www.xingyunyi.com/tracking shows only on desktop-size screens, which the phone-size check does not use',
  'yamato-america': 'the phone page names its number field s and asks for "No.", which the check reads as a site search; the desktop page asks for a tracking number',
  'yc-delivery': 'www.e1.yc-otodoke.com answers 403 or 503 to many networks outside Japan; an archived copy shows its inquiry-number fields',
  ziegler: 'the Easytrack page opens on its sign-in form; its tracking number field shows once its "Tracking number" choice is clicked',
};
