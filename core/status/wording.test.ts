import { describe, expect, it } from 'vitest';
import { classifyWording, wordingStage } from './wording.js';
import { trackingLanguageStage } from './language.js';

describe('classifyWording', () => {
  it.each(['Not delivered to sender', 'Will be delivered back to sender', 'May have been delivered to the sender',
    "Wasn't delivered back to shipper", 'To be delivered to the shipper', 'Being delivered back to sender', 'Will not be delivered to sender'])(
    'does not complete sender delivery from %s', wording => {
      expect(trackingLanguageStage(wording)).toBe('exception');
      expect(wordingStage(wording)).toBe('exception');
    },
  );
  it.each(['Returning to sender', 'Return to sender', 'The item will be returned to sender',
    'To be returned to the sender', 'The item is being returned to the sender', 'Return initiated',
    'Will soon be returned to sender', 'Not yet returned to sender', 'Could not be returned to sender',
    'Cannot be returned to sender', 'Will not be returned to sender', "Hasn't been returned to sender",
    'Hasn’t yet been returned to the sender', "Won't be returned to sender", "Wasn't returned to sender",
    'May be returned to sender', 'Should be returned to sender', 'Might have been returned to sender',
    'Will have been returned to sender', 'Could already have been returned to sender'])(
    'keeps %s nonterminal', wording => {
      expect(wordingStage(wording)).toBe('exception');
    },
  );

  it.each(['Returned to sender', 'Has been returned to the sender', 'Delivered back to sender',
    'Delivered to the shipper', 'Has been delivered back to the sender',
    'Has already been returned to sender', 'The item was not delivered and has been returned to sender',
    'Not delivered to recipient; delivered back to sender'])(
    'recognizes completed sender delivery: %s', wording => {
      expect(wordingStage(wording)).toBe('returned');
    },
  );

  it('names the rule that decided the stage', () => {
    expect(classifyWording('Delivery attempt failed')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(classifyWording('Confirmation of receipt')).toEqual({ stage: 'delivered', source: 'wording:delivered' });
    expect(classifyWording('Parcel is out for delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(classifyWording('Reported')).toEqual({ stage: 'registered', source: 'wording:language' });
  });

  it('classifies carrier-reported problems as exception', () => {
    expect(classifyWording('Colis endommagé')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(classifyWording('Package refused by the recipient')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(classifyWording('Indirizzo errato')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(classifyWording('Carrier exception')).toEqual({ stage: 'exception', source: 'wording:exception_incident' });
    expect(classifyWording('Updated delivery address required from customer')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(wordingStage('Przesyłka zatrzymana')).toBe('exception');
  });

  it('keeps missed delivery attempts and returns out of exception', () => {
    expect(wordingStage('Delivery attempt, recipient absent')).toBe('failed_attempt');
    expect(wordingStage('Non livré, destinataire absent')).toBe('failed_attempt');
    expect(wordingStage('Retour à l\'expéditeur')).toBe('returned');
  });

  it('reads missed rounds worded around the attempt, the absent recipient or a closed business', () => {
    for (const wording of [
      "We've attempted to deliver the shipment, but the customer was not available at the time. Not to worry, the delivery has been rescheduled",
      "We've attempted to deliver the shipment, but the customer was not available at the time. Not to worry, the delivery will be re-attempted",
      'Attempted delivery - receiver unavailable',
      'Absence. Attempted delivery.',
      '<User not at home>',
      'Unsuccessful delivery. Reason : Absence of addressee Result :',
      "We're sorry but we were unable to complete your delivery. Please continue to check your tracking for real time updates",
      'The driver tried to deliver the package, but the business was closed. We will reattempt up to 3 times. Contact us with any access or delivery instructions',
      'Business closed. Please provide hours',
    ]) expect(classifyWording(wording)).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    // A scheduled attempt, a sender pickup attempt or a hypothetical absence is not a missed round.
    for (const wording of [
      'Attempted delivery tomorrow', 'Attempted delivery scheduled for tomorrow', 'Delivery will be attempted tomorrow',
      'Pickup attempted', 'Pickup attempted - business closed', 'Attempted pickup, customer not available',
      'If you are not at home, the courier will leave the parcel with a neighbour',
      'If the recipient is not available, the parcel goes to the nearest pickup point',
    ]) expect(wordingStage(wording, 'pending')).not.toBe('failed_attempt');
  });

  it('reads the postal and aggregator labels of first scans, the round and delivery', () => {
    for (const [wording, stage] of [
      ['Posting/Collection', 'accepted'],
      ['Posted', 'accepted'],
      ['Origin Scan', 'accepted'],
      ['The shipment has been received at our Aramex origin office and will continue its journey to the destination country', 'accepted'],
      ['The shipment item has been dropped off after latest drop-off time.', 'accepted'],
      ['Item created', 'registered'],
      ['Item out for physical delivery', 'out_for_delivery'],
      ['Final delivery', 'delivered'],
    ] as const) expect(classifyWording(wording)).toEqual({ stage, source: 'wording:language' });
    for (const wording of ['Final delivery attempt tomorrow', 'Posted to the wrong address']) {
      expect(wordingStage(wording, 'pending')).not.toBe('delivered');
      expect(wordingStage(wording, 'pending')).not.toBe('accepted');
    }
  });

  it('tells a courier on the round from a notice that only mentions the round', () => {
    expect(classifyWording("An Aramex Delivery Champion has the shipment and is expected to reach the customer's doorstep shortly"))
      .toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    // New instructions with the round still to come, like "Delivery option requested".
    expect(wordingStage('The customer has shared new delivery instructions and the status will be updated once shipment is out for delivery'))
      .toBe('in_transit');
  });

  it('keeps sender pre-advice and labels the carrier has not received at registered', () => {
    for (const wording of [
      'We have received a notification from your shipper that they are preparing an item for you. The tracking information will be updated when the parcel is handed over to PostNord.',
      'Shipper generated a new shipment label, but the shipment has not been handed over to Aramex, yet. Shipment will be updated once collected from shipper and received in Aramex offices',
      'The package data was sent to OnTrac, but we have yet to receive the package from the sender. Tracking will update once it arrives. Please contact the sender for more information',
    ]) expect(classifyWording(wording)).toEqual({ stage: 'registered', source: 'wording:language' });
    // The carrier itself taking the parcel is still acceptance.
    expect(wordingStage('The parcel was handed over to GLS.')).toBe('accepted');
    // A handover that has not happened is not, with or without "yet".
    for (const wording of ['The parcel has not been handed over to GLS.', "The parcel hasn't been handed over to DPD",
      'Shipment not handed over to the carrier']) {
      expect(classifyWording(wording), wording).toEqual({ stage: 'registered', source: 'wording:language' });
    }
    // Nor is a parcel not handed to the recipient's side or to customs still with its sender.
    for (const wording of ['The parcel was not handed over to the recipient', 'Parcel was not handed over to a neighbour',
      'Parcel has not been handed over to customs', 'The parcel was not handed to you', 'Parcel not handed to the person named']) {
      expect(wordingStage(wording), wording).not.toBe('registered');
    }
  });

  it('reads a handover that has not happened as registered in French, German and Italian too', () => {
    for (const wording of [
      "Le colis n'a pas encore été remis à GLS.", "Le colis n'a pas été remis au transporteur",
      'Colis pas encore confié au transporteur', "Le colis n'a jamais été remis à l'opérateur",
      'Das Paket wurde noch nicht an GLS übergeben.', 'Die Sendung ist noch nicht an den Paketdienst übergeben worden',
      'Paket noch nicht an DPD übergeben', 'Il pacco non è ancora stato affidato a GLS.',
      'Spedizione non affidata al corriere', "Pacco non ancora affidato all'operatore",
    ]) expect(classifyWording(wording), wording).toEqual({ stage: 'registered', source: 'wording:language' });
    // The handover made keeps its reading.
    for (const [wording, stage] of [
      ['Le colis a été remis à GLS.', 'accepted'], ['Le colis a été remis au transporteur', 'in_transit'],
      ['Il a été remis au transporteur pour son acheminement.', 'in_transit'],
      ['Das Paket wurde an GLS übergeben.', 'accepted'], ['Il pacco è stato affidato a GLS.', 'accepted'],
    ] as const) expect(wordingStage(wording), wording).toBe(stage);
    // So does what else the scan reports.
    expect(wordingStage('Im Paketzentrum angekommen; noch nicht an den Zusteller übergeben')).toBe('in_transit');
    // Only a handover to a carrier or an operator that has not happened: not one that
    // cannot or will not happen, nor one to the recipient's side, a place, the sender or
    // customs, nor an idiom. Each keeps the reading it had.
    for (const [wording, stage] of [
      ['Die Sendung konnte nicht an der Haustür übergeben werden', 'pending'],
      ['Das Paket wird nicht an Feiertagen übergeben', 'pending'],
      ['Le colis ne peut pas être remis au point relais', 'pending'],
      ["Le suivi n'a pas été remis à jour", 'pending'],
      ['Le colis ne sera pas remis au transporteur', 'in_transit'],
      ['Retour : colis pas remis au point relais', 'returned'],
      ['Il pacco non è stato affidato al corriere: mancata consegna', 'failed_attempt'],
      ["Le colis n'a pas encore été remis au destinataire", 'pending'],
      ["Le colis n'a pas été remis à la douane", 'customs'],
      ["Le colis n'a pas encore été remis à l'expéditeur", 'pending'],
      ['Das Paket wurde noch nicht an den Empfänger übergeben', 'pending'],
      ['Das Paket wurde nicht an die Packstation übergeben', 'pending'],
      ['Das Paket wurde nicht an den Zoll übergeben', 'customs'],
      ['Il pacco non è ancora stato affidato al destinatario', 'pending'],
      ["Il pacco non è stato affidato all'indirizzo indicato", 'pending'],
      ['Il pacco non è stato affidato alla dogana', 'customs'],
      // A carrier's shop, locker or pickup point is a place too, named by brand or not.
      ['Das Paket wurde noch nicht an die DHL Packstation übergeben', 'pending'],
      ['Paket noch nicht an DHL-Packstation übergeben', 'pending'],
      ['Das Paket wurde noch nicht an den GLS PaketShop übergeben', 'pending'],
      ['Das Paket wurde noch nicht an den Hermes PaketShop übergeben', 'pending'],
      ['Das Paket wurde noch nicht an den DPD Pickup Paketshop übergeben', 'pending'],
      ['Das Paket wurde noch nicht an den UPS Access Point übergeben', 'pending'],
      ['Das Paket wurde noch nicht an die Post Filiale übergeben', 'pending'],
      ["Le colis n'a pas encore été remis au Chronopost Pickup", 'pending'],
      ["Le colis n'a pas encore été remis à UPS Access Point", 'pending'],
      ["Le colis n'a pas encore été remis à la poste restante", 'pending'],
      ['Il pacco non è ancora stato affidato al BRT-fermopoint', 'pending'],
      ['Il pacco non è ancora stato affidato a InPost locker', 'pending'],
      ['Parcel not yet handed to the DHL Packstation', 'pending'],
    ] as const) expect(wordingStage(wording, 'pending'), wording).toBe(stage);
    // The carrier named on its own, or its post, still is one.
    for (const wording of ["Le colis n'a pas encore été remis à la Poste", "Le colis n'a pas encore été remis aux transporteurs",
      'Il pacco non è ancora stato affidato alle Poste', 'Das Paket ist noch nicht an die Deutsche Post übergeben worden']) {
      expect(classifyWording(wording), wording).toEqual({ stage: 'registered', source: 'wording:language' });
    }
  });

  it('reads a hold the recipient asked for as a delivery choice, not a problem', () => {
    for (const wording of [
      "Item on hold at recipient's request", 'Held at customer request', 'On hold per recipient’s request',
      'Shipment held at the request of the consignee', 'Customer requested hold',
      'Article retenu à la demande du destinataire', 'Sendung auf Wunsch des Empfängers zurückgehalten',
      'Spedizione trattenuta su richiesta del destinatario', 'Retenido a petición del destinatario',
      'Retido a pedido do destinatário', 'Przesyłka zatrzymana na prośbę odbiorcy',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'in_transit', source: 'wording:language' });
    // Held at a counter for the recipient to collect.
    expect(wordingStage('Held at Post Office, At Customer Request')).toBe('ready_for_pickup');
    expect(wordingStage('Fermo in ufficio postale su richiesta del destinatario')).toBe('ready_for_pickup');
    // A hold nobody asked for, or a missed attempt, keeps its own stage.
    for (const wording of ['Shipment on hold', 'Shipment held, awaiting instructions', 'Colis retenu', 'Sendung zurückgehalten']) {
      expect(wordingStage(wording), wording).toBe('exception');
    }
    expect(wordingStage("Delivery attempt failed; parcel on hold at recipient's request")).toBe('failed_attempt');
  });

  it('keeps postal storage wording (a parcel waiting for collection) out of exception', () => {
    expect(wordingStage('In giacenza presso l\'ufficio postale')).not.toBe('exception');
    expect(wordingStage('Colis en souffrance au bureau de poste')).not.toBe('exception');
  });

  it('recognizes a parcel waiting at a pickup point in the wording carriers actually use', () => {
    for (const wording of [
      'Votre colis vous attend dans votre point de retrait. Le délai de retrait est de 5 jours.',
      'Colis mis à disposition au point de retrait',
      'Le message de mise à disposition en point relais a été reçu par le destinataire.',
      '5 jours restants pour retirer le colis en Locker',
      'Delivered to an access point location and awaiting customer pickup.',
    ]) expect(classifyWording(wording)).toEqual({ stage: 'ready_for_pickup', source: 'wording:language' });
    // Travelling to the pickup point, or handed back to the seller, is not availability.
    expect(wordingStage('Colis en cours de livraison au point de retrait')).toBe('in_transit');
    expect(wordingStage('Colis mis à disposition du vendeur suite à un retour')).toBe('returned');
  });

  it('reads French missed attempts, same-day delivery notices and mailbox deliveries', () => {
    expect(wordingStage('Nous sommes passés mais nous n\'avons pu vous remettre votre colis. Il va être acheminé vers votre point de retrait.')).toBe('failed_attempt');
    expect(wordingStage('Votre envoi n\'a pas pu être distribué ce jour.')).toBe('failed_attempt');
    // A day's delivery called off, worded as the next round to come.
    expect(wordingStage('Votre colis ne peut être livré ce jour. Il sera mis en livraison au plus tôt.')).toBe('failed_attempt');
    expect(wordingStage('Il sera mis en livraison au plus tôt.')).toBe('in_transit');
    expect(wordingStage("Echec de livraison suite à l'absence du destinataire.")).toBe('failed_attempt');
    expect(wordingStage("Avis de passage suite à l'absence du destinataire")).toBe('failed_attempt');
    expect(wordingStage("En cas d'absence du destinataire, le colis sera déposé en point relais")).not.toBe('failed_attempt');
    expect(wordingStage('Livraison reportée de 24h')).toBe('in_transit');
    expect(wordingStage('Le destinataire est informé par SMS de la livraison de son colis ce jour')).toBe('out_for_delivery');
    expect(wordingStage('Le destinataire est informé par e-mail de la livraison de son colis ce jour')).toBe('out_for_delivery');
    expect(wordingStage('Votre envoi a été distribué dans la boîte à lettres.')).toBe('delivered');
    // An announced distribution is not a delivery.
    expect(wordingStage('Votre envoi sera distribué dans la journée.')).toBe('in_transit');
    expect(wordingStage('Votre colis va être distribué à votre adresse.')).toBe('in_transit');
    expect(wordingStage('Instruction de livraison reçue')).toBe('in_transit');
    expect(wordingStage('Colis expédié depuis le site logistique')).toBe('in_transit');
  });

  it('separates customs formalities in progress from their completion', () => {
    expect(wordingStage('Les formalités import/export sont en cours sur votre colis.')).toBe('customs');
    expect(wordingStage('Les formalités import/export de votre colis sont terminées et il poursuit son acheminement.')).toBe('in_transit');
    expect(wordingStage('Import customs clearance started')).toBe('customs');
    for (const wording of ['Import customs clearance complete', 'Export clearance success', 'Leaving customs', 'Departed from customs']) {
      expect(wordingStage(wording)).toBe('in_transit');
    }
  });

  it('reads verb-first clearance as completed and keeps negated or pending clearance in customs', () => {
    for (const wording of [
      'Your parcel cleared customs successfully', 'Cleared customs', 'Shipment cleared by customs',
      'The parcel has been cleared through customs',
    ]) {
      expect(classifyWording(wording)).toEqual({ stage: 'in_transit', source: 'wording:language' });
    }
    for (const wording of [
      'The parcel has not cleared customs yet', 'Parcel has not yet been cleared through customs',
      "Shipment hasn't cleared customs", 'Your parcel will be cleared through customs',
      'Parcel is being cleared by customs',
    ]) {
      expect(wordingStage(wording)).toBe('customs');
    }
  });

  it('distinguishes release from import or export customs from pending release', () => {
    for (const customs of ['customs', 'import customs', 'export customs', 'import/export customs']) {
      expect(wordingStage(`Released from ${customs}`)).toBe('in_transit');
      expect(wordingStage(`Item has been released from ${customs}`)).toBe('in_transit');
      for (const prefix of ['Item has not been', 'Item has not yet been', "Item hasn't been", 'Item will be', 'Item is being']) {
        expect(wordingStage(`${prefix} released from ${customs}`)).toBe('customs');
      }
    }
  });

  it('reads a customs hold as customs and a customs problem as an exception', () => {
    for (const wording of [
      'Held by customs', 'Held by Custom', 'Shipment held at customs', 'Parcel on hold at customs', 'Customs hold',
      'Detained by customs', 'Colis retenu en douane', 'Vom Zoll zurückgehalten', 'Fermo in dogana', 'Retenido en aduana',
      'Retido na alfândega', 'Przesyłka zatrzymana przez urząd celny',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'customs', source: 'wording:language' });
    for (const wording of ['Customs issue', 'Customs problem, documents missing', 'Problème de douane', 'Zollproblem',
      'Problema doganale', 'Problema de aduana', 'Problem celny', 'Shipment on hold']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'exception', source: 'wording:language' });
    }
    expect(wordingStage('Customs hold lifted')).toBe('in_transit');
    expect(wordingStage('Held by customs, delivery attempt failed')).toBe('failed_attempt');
  });

  it('reads a completed release or clearance as transit in each language', () => {
    for (const wording of [
      'Released From Import Customs', 'Shipment released from customs', 'Cleared by the broker and released at customs',
      'Customs clearance finished', 'Customs clearance processing complete', 'Parcel has cleared export customs',
      'Left the customs terminal', 'Item returned from import customs', 'Released from customs hold',
      'Problème douanier résolu, colis en cours d’acheminement', 'Colis dédouané', 'Dédouanement effectué', 'Sorti de la douane',
      'Verzollung abgeschlossen', 'Sendung verzollt', 'Zollfreigabe erfolgt', 'Die Sendung hat den Zoll verlassen',
      'Spedizione sdoganata', 'Sdoganamento effettuato', 'Svincolo avvenuto', 'Uscito dalla dogana',
      'Liberado por aduana', 'Salida de aduana', 'Trámites de aduana finalizados',
      'Liberado pela alfândega', 'Desalfandegado', 'Fiscalização aduaneira finalizada',
      'Odprawa celna zakończona', 'Przesyłka odprawiona celnie',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'in_transit', source: 'wording:language' });
    // Holds, inspections, submissions and a release still to come stay with customs.
    for (const wording of [
      'Not yet released by import customs', 'Your parcel will be released from customs after payment',
      'Once released from customs, your parcel will be forwarded', 'Customs clearance will be completed soon',
      'Customs clearance in progress, documents completed', 'The shipment item is being customs cleared by us.',
      'Awaiting release from customs', 'Released to customs broker', 'Held for export customs inspection', 'Submitted to customs',
      "Le colis n'a pas encore été dédouané", "Colis en attente d'être dédouané", 'Die Sendung wird verzollt', 'Noch nicht verzollt',
      'Non ancora sdoganato', 'In attesa di essere sdoganato', 'Pendiente de liberación por aduana', 'No ha sido liberado por aduana',
      'Envío en aduana', 'Não foi liberado pela alfândega', 'Encaminhado para fiscalização aduaneira',
      'Przesyłka oczekuje na odprawę celną', 'Nie została odprawiona celnie',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'customs', source: 'wording:language' });
  });

  it('maps sender drop-off and carrier pickup scans to accepted', () => {
    for (const wording of [
      'Drop-Off', 'Pickup Scan', 'Pick-up scan',
      'The UPS Access Point™ location has prepared the package for return to UPS or pickup by UPS.',
    ]) expect(classifyWording(wording)).toEqual({ stage: 'accepted', source: 'wording:language' });
    // Recipient-side pickup wording must not be read as the carrier accepting the parcel.
    expect(wordingStage('Ready for pickup')).toBe('ready_for_pickup');
    expect(wordingStage('Drop-off point closed, delivery attempt failed')).toBe('failed_attempt');
    // Only the bare scan label is the sender's hand-in; a parcel left at the recipient's pickup shop is not.
    expect(wordingStage('Your parcel has been dropped off at your chosen pickup shop')).not.toBe('accepted');
  });

  it('maps facility scans, handovers and notices that carry no milestone of their own', () => {
    for (const wording of [
      'At local carrier facility', 'Left origin facility', 'Parcel is leaving airport', 'Item Dispatched', 'Delay',
      'Received by local delivery company', 'Received by logistics company', 'Delivery option requested',
      'The notification for delivery has been sent to the recipient',
      'Item handed over to delivery partner', 'Item distributed', 'The shipment item has been loaded.',
      'Your package has been loaded onto a vehicle',
    ]) expect(classifyWording(wording)).toEqual({ stage: 'in_transit', source: 'wording:language' });
    expect(wordingStage('On vehicle for delivery')).toBe('out_for_delivery');
    expect(wordingStage('On FedEx vehicle for delivery')).toBe('out_for_delivery');
    expect(wordingStage('Loaded onto the delivery vehicle')).toBe('out_for_delivery');
    expect(wordingStage('Delivery successful.')).toBe('delivered');
    expect(wordingStage('Delivery complete. Recipient : () Result : Delivery complete')).toBe('delivered');
    expect(wordingStage('Delivery completion expected tomorrow', 'pending')).not.toBe('delivered');
    expect(wordingStage('Parcel Data Received')).toBe('registered');
    expect(wordingStage('Shipment information sent to FedEx')).toBe('registered');
    // A parcel left with the recipient is a delivery, not a departure.
    expect(wordingStage('Delivered, left at front door')).toBe('delivered');
  });

  it('reads the Spanish and Portuguese labels carriers send', () => {
    // Labels from the carrier vocabularies (statuses.json) and TIPSA's history on ParcelsApp.
    for (const [wording, stage] of [
      ['ENTREGADO', 'delivered'],
      ['EL ENVÍO HA SIDO ENTREGADO A UN VECINO.', 'delivered'],
      ['Entregue', 'delivered'],
      ['Objeto entregue ao destinatário', 'delivered'],
      ['REPARTO', 'out_for_delivery'],
      ['EL ENVÍO ESTÁ EN REPARTO.', 'out_for_delivery'],
      ['En proceso de entrega a domicilio', 'out_for_delivery'],
      ['Objeto saiu para entrega ao destinatário', 'out_for_delivery'],
      ['Ausente', 'failed_attempt'],
      ['Intento de entrega. Ausente', 'failed_attempt'],
      ['Realizado intento de entrega', 'failed_attempt'],
      ['Disponible en punto NACEX', 'ready_for_pickup'],
      ['Disponible en Punto Collectt Express', 'ready_for_pickup'],
      ['DEVUELTO', 'returned'],
      ['En devolución', 'exception'],
      ['LECTURA EN AGENCIA DESTINO [location]', 'in_transit'],
      ['LEIDO EN DESTINO', 'in_transit'],
      ['Clasificado', 'in_transit'],
      ['Alta en la unidad de reparto', 'in_transit'],
      ['EN RUTA A LOCALIDAD DE DESTINO', 'in_transit'],
      ['Objeto em transferência - por favor aguarde', 'in_transit'],
      ['Saída do Centro Internacional', 'in_transit'],
      ['PENDIENTE DE ENTREGAR A TIPSA', 'registered'],
      ['Pendiente de recepción en CTT Express', 'registered'],
    ] as const) expect(classifyWording(wording)).toEqual({ stage, source: 'wording:language' });
    // Carriers disagree on a new round, and a failed pickup or a cancelled round is
    // not a missed delivery: the carrier maps decide these.
    for (const wording of ['NUEVO REPARTO', 'Recogida fallida', 'Saída para entrega cancelada']) {
      expect(trackingLanguageStage(wording)).toBeUndefined();
    }
  });

  it('keeps Spanish and Portuguese negations, handoffs, returns and forecasts apart from delivery', () => {
    for (const [wording, stage] of [
      ['No entregado', 'failed_attempt'],
      ['No se ha podido entregar', 'failed_attempt'],
      ['Não entregue', 'failed_attempt'],
      ['Não foi possível efetuar a entrega', 'failed_attempt'],
      ['Objeto não entregue - carteiro não atendido', 'failed_attempt'],
      ['Estabelecimento fechado', 'failed_attempt'],
      ['Em distribuição', 'out_for_delivery'],
      ['Está a ser entregue', 'out_for_delivery'],
      ['Chegada ao centro de distribuição', 'in_transit'],
      ['Entregado al transportista', 'in_transit'],
      ['Entregue à transportadora', 'in_transit'],
      ['Entregado en el punto de recogida', 'ready_for_pickup'],
      ['Entregue no cacifo', 'ready_for_pickup'],
      ['Disponível para levantamento', 'ready_for_pickup'],
      ['Entregado al remitente', 'returned'],
      ['Devolvido ao remetente', 'returned'],
      ['Será devuelto al remitente', 'exception'],
      ['O envio está a ser devolvido ao remetente', 'exception'],
      ['Não foi devolvido', 'exception'],
      ['Su envío ha llegado al centro de distribución y será entregado mañana', 'in_transit'],
      ['A encomenda chegou ao centro de distribuição e será entregue amanhã', 'in_transit'],
      ['Pendiente de entrega', 'in_transit'],
      ['Estará disponible para recoger mañana', 'in_transit'],
    ] as const) expect(classifyWording(wording)).toEqual({ stage, source: 'wording:language' });
    // A condition, a scheduled attempt, a sender pickup or a delivery still to come.
    for (const wording of [
      'Si el destinatario está ausente, el paquete irá al punto de recogida',
      'Em caso de ausência, o envio fica no ponto de recolha',
      'Intento de entrega programado para mañana',
      'Intento de recogida, cliente ausente',
      'Recibirás un SMS una vez entregado',
      'Quando for entregue, receberá um SMS',
      'Fecha de entrega modificada',
      'No disponible para recoger',
    ]) expect(['delivered', 'failed_attempt', 'ready_for_pickup']).not.toContain(wordingStage(wording, 'pending'));
  });

  // GENERATED notices: a delivery still to come reports no movement, so a
  // forecast alone takes the caller's fallback and a sentence that also
  // reports a scan keeps that scan's stage.
  it.each(['Your parcel will be delivered on Tuesday between 10:00 a.m. and 11:00 a.m.',
    'Your parcel will be delivered to a safe place as you instructed', 'Your parcel will now be delivered on Wednesday',
    'Will not be delivered today', "Won't be delivered before Monday", 'Your parcel will be delivered to a pickup point',
    'Votre colis sera livré demain', 'Il sera livré après paiement des droits et taxes', 'Votre colis va être livré aujourd’hui',
    'Ihre Sendung wird am Dienstag zugestellt', 'Voraussichtliche Zustellung am 06.10.2026', 'Zustellung voraussichtlich morgen',
    'Il pacco sarà consegnato domani', 'Il pacco verrà consegnato domani', 'Será entregado mañana', 'Se entregará a la mayor brevedad',
    'Será entregue amanhã', 'Vai ser entregue hoje'])('gives the notice "%s" no stage', wording => {
    expect(trackingLanguageStage(wording)).toBeUndefined();
    expect(classifyWording(wording, 'pending')).toEqual({ stage: 'pending', source: 'none' });
    expect(classifyWording(wording, 'in_transit')).toEqual({ stage: 'in_transit', source: 'none' });
  });

  it.each([
    ['Your parcel has arrived at the depot and will be delivered tomorrow', 'in_transit'],
    ['Out for delivery. Your parcel will be delivered between 10:00 and 11:00', 'out_for_delivery'],
    ['Label created; your parcel will be delivered by the carrier', 'registered'],
    ['Shipment information received, it will be delivered next week', 'registered'],
    ["Les formalités d'importation de votre envoi sont terminées et il sera livré contre paiement des droits et taxes", 'in_transit'],
    ['Les formalités d’importation de votre envoi sont terminées et il sera livré contre paiement de droits et taxes de douane.', 'in_transit'],
    ['Votre colis est dédouané. Il sera livré contre paiement des droits et taxes de douane', 'in_transit'],
    ['Votre colis est en cours de livraison, il sera livré avant 13 h', 'out_for_delivery'],
    ['Die Sendung ist im Paketzentrum angekommen und wird voraussichtlich am 06.10.2026 zugestellt', 'in_transit'],
    ['Die Sendung wird heute nicht zugestellt', 'failed_attempt'],
    ['Não será entregue hoje', 'failed_attempt'],
    ['Delivery attempt failed. Your parcel will be delivered again tomorrow', 'failed_attempt'],
    ['Your parcel cannot be delivered', 'failed_attempt'],
    ['Will be delivered back to sender', 'exception'],
  ] as const)('reads only what "%s" reports: %s', (wording, stage) => {
    expect(classifyWording(wording, 'pending')).toEqual({ stage, source: 'wording:language' });
  });

  it('files a linehaul handover as transit, not acceptance', () => {
    expect(classifyWording('Handed over from linehaul office', 'pending')).toEqual({ stage: 'in_transit', source: 'wording:language' });
    expect(classifyWording('Parcel handed over', 'pending')).toEqual({ stage: 'accepted', source: 'wording:accepted' });
  });

  it('reads the last-mile wording that consolidators relay', () => {
    for (const [wording, stage] of [
      ['Your package is ready to be picked up.', 'ready_for_pickup'],
      ['Parcel has been handed over to a third-party courier', 'in_transit'],
      ['New delivery attempt on the next delivery day', 'in_transit'],
      ['We missed each other', 'failed_attempt'],
      ['We missed you. We deliver your shipment at a pickup point.', 'failed_attempt'],
      ['No payment, new delivery attempt on the next delivery day', 'failed_attempt'],
      ['Shipment not yet received or processed', 'registered'],
      ['Registered parcel data, parcel not dispatched yet', 'registered'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
    // A notice the carrier failed to send is no scan; a failed delivery still is.
    for (const wording of ['REMINDER EMAIL SENT FAILED', 'SMS notification failed', 'Failed to send notification for collection']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'pending', source: 'none' });
    }
    expect(wordingStage('Failed delivery notification sent')).toBe('failed_attempt');
    // A parcel the carrier still has to collect, a failed new attempt, a missed
    // round with the parcel waiting, a parcel already abroad.
    expect(wordingStage('Parcel ready to be picked up by the courier')).not.toBe('ready_for_pickup');
    expect(wordingStage('New delivery attempt failed')).toBe('failed_attempt');
    expect(wordingStage('We missed each other, ready for collection at the sorting centre')).toBe('ready_for_pickup');
    expect(wordingStage('Item not yet received at the destination office')).not.toBe('registered');
  });

  it('lets the rest of a scan outrank a step not yet taken and a courier handover', () => {
    for (const [wording, stage] of [
      // A step the carrier has not taken yet leaves the rest of the scan to read.
      ['Clearance delay: payment not yet received', 'customs'],
      ['Arrived at hub; not yet processed', 'in_transit'],
      ['Parcel not yet handed over to the courier', 'registered'],
      // The courier alone is the round; a carrier or a courier set apart is another network.
      ['Out for delivery, handed over to our courier', 'out_for_delivery'],
      ['Handed over to the courier', 'out_for_delivery'],
      ['Handed Over to SingPost Courier', 'in_transit'],
      ['Handed over to the last-mile carrier', 'in_transit'],
      ['Handed over to the courier company', 'in_transit'],
      ['Handed over to The Courier Guy', 'in_transit'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
    // A pickup order, a return or the sender's hand-in is not the round.
    for (const wording of ['Pickup order handed over to the courier', 'Return handed over to the courier',
      'Parcel handed over to the courier by the sender']) expect(trackingLanguageStage(wording), wording).toBeUndefined();
  });

  it('reads customs from Spanish and Portuguese stems, not from a Malay or Indonesian complaint', () => {
    for (const wording of ['Pengaduan pelanggan diterima', 'Aduan pelanggan diterima']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'pending', source: 'none' });
    }
    for (const wording of ['Envío en aduana', 'Gestión aduanera en curso', 'Desaduanaje en proceso',
      'Em fiscalização aduaneira', 'Aguardando liberação aduaneira']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'customs', source: 'wording:language' });
    }
  });

  it('reads the first scans, the round and a cancellation that universal providers relayed', () => {
    for (const [wording, stage] of [
      // Sender data and a shipment record, as Paack's, DPD UK's, InPost's and Asendia's maps file them.
      ['order details received', 'registered'],
      ["We've received your order details, but have not yet received your parcel", 'registered'],
      ['Dane zamówienia otrzymane', 'registered'],
      ['shipment created', 'registered'],
      ['Przesyłka utworzona', 'registered'],
      ['Gönderi oluşturuldu', 'registered'],
      // Correos: left for admission, pre-registered, admitted.
      ['depositado para admisión. envío depositado por remitente en taquilla citypaq para admisión por correos', 'registered'],
      ['Entregado en CityPaq para admisión', 'registered'],
      ['pre-registered. shipment pre-registered in the postal correos spain system, pending acceptance', 'registered'],
      ['Prerregistrado', 'registered'],
      ['admitido.. el envío ha tenido admisión en origen.', 'accepted'],
      ['ADMITIDO EN OFICINA DE CORREOS', 'accepted'],
      // DHL Express's round.
      ['shipment is out with courier for delivery', 'out_for_delivery'],
      // A cancellation, as carriers' codes file it.
      ['i̇ptal edildi', 'exception'],
      ['Gönderi iptal edildi', 'exception'],
      ['Order canceled', 'exception'],
      ['Your parcel has been cancelled', 'exception'],
      ['Przesyłka anulowana', 'exception'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
    // A cancelled return, pickup or hold lets the parcel go on; a return
    // label is no new shipment; refused admission and a pickup round are
    // not these steps. Too specific or too bare to read: Paack's origin
    // scan, a Turkish "entered", Swiss Post's forward order.
    for (const wording of ['Return cancelled', 'Pickup cancelled', 'Hold cancelled', 'Pickup order cancelled',
      'Return shipment created', 'No admitido', 'Out with driver for pickup',
      "in paack's distribution centre", 'girildi', 'order triggered by recipient: forward']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'pending', source: 'none' });
    }
  });

  it('reads the recipient collecting a parcel as delivered, and the courier collecting it as acceptance', () => {
    for (const wording of [
      // By the recipient, consignee, addressee or customer, as DPD Germany, DHL eCommerce and Asendia word it.
      'Parcel picked up by recipient', 'Picked up by consignee', 'Picked up from Pickup parcelshop by consignee.',
      'Picked up from DPD Pickup station by consignee.', 'Collected by the recipient', 'collected by recipient',
      'Collected at DHL ServicePoint by the recipient', 'Your shipment has been collected by consignee at the parcelshop',
      'The recipient has picked up the shipment from the retail outlet.', 'Your parcel was collected by the addressee',
      'Picked up by the customer', 'Picked-up by recipient',
      // From a pickup point, a locker or a counter.
      'Your parcel has been picked up from the Pickup point', 'Collected from DHL Locker by the recipient',
      'Item collected from Parcel Locker', 'Final delivery - Collected at counter', 'Collected at the post office counter',
      // French, German, Italian, Spanish, Portuguese and Polish.
      'Retiré par le destinataire', 'Colis retiré par son destinataire', 'Votre colis a été retiré au point relais',
      'Le destinataire a retiré son colis', 'Vom Empfänger abgeholt', 'Die Sendung wurde vom Empfänger in der Filiale abgeholt.',
      'Der Empfänger hat die Sendung in der Filiale abgeholt.', 'Die Sendung wurde aus der Packstation abgeholt.',
      'Ritirato dal destinatario', "La spedizione è stata ritirata dal destinatario presso l'ufficio postale",
      'Il destinatario ha ritirato la spedizione', 'Recogido por el destinatario', 'Retirado por el destinatario',
      'El destinatario ha retirado el envío de la tienda SEUR Pickup seleccionada.', 'Levantado pelo destinatário',
      'Odebrana przez odbiorcę',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'delivered', source: 'wording:language' });
    // A bare pickup is the sender's hand-in, and so is the courier's collection, even at a pickup point.
    for (const wording of ['Picked up', 'Picked up at the client', 'Picked up by the courier', 'Picked up by the driver',
      'Picked up from the sender', 'Picked up from shipper', 'Picked up at DHL ServicePoint by the courier',
      'Picked up from DHL Locker by the courier', 'Picked up at post office by the courier', 'Picked up at parcelshop']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'accepted', source: 'wording:language' });
    }
    // A parcel shop or service point also takes in drop-offs the courier
    // collects. Nor is a pickup point taking the parcel in, a mailbox
    // collection, a sender pickup or a parcel taken off the round a delivery.
    for (const wording of ['The shipment has been collected from the ServicePoint', 'Collected from the pickup point by the courier',
      'Parcel collected by pickup point', 'Shipment collected from the shipper', 'We successfully picked it up from your mailbox.',
      'Die Sendung wurde beim Absender abgeholt', 'Die Sendung wurde vom Paketboten in der Filiale abgeholt', 'Ritirato dal corriere',
      'Colis retiré de la tournée', 'Picked up by customer service']) {
      expect(wordingStage(wording, 'pending'), wording).not.toBe('delivered');
    }
    // A parcel still to collect.
    for (const wording of ['Ready to be picked up', 'Ready to be picked up by the recipient', 'Your parcel is ready to be collected',
      'Prêt à être retiré']) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'ready_for_pickup', source: 'wording:language' });
    for (const wording of ['To be collected by the recipient', 'The parcel can be collected from the parcel locker',
      'Your parcel will be kept at the pickup point until it is collected', 'Die Sendung kann vom Empfänger in der Filiale abgeholt werden',
      'Held at the counter until collected by the recipient']) {
      expect(wordingStage(wording, 'pending'), wording).not.toBe('delivered');
    }
    // A parcel nobody collected, which Spanish and Portuguese used to read as delivered.
    for (const wording of ['Not collected by the recipient', 'Not collected at DHL ServicePoint', 'Parcel not picked up by the recipient',
      'Parcel has not been collected from the pickup point', 'The recipient has not collected the parcel', 'Non retiré par le destinataire',
      "Le colis n'a pas été retiré par le destinataire", 'Vom Empfänger nicht abgeholt', 'Non ritirato dal destinatario',
      'No recogido por el destinatario', 'Não levantado pelo destinatário']) {
      expect(wordingStage(wording, 'pending'), wording).not.toBe('delivered');
    }
    for (const [wording, stage] of [
      ['Not collected by the recipient, return to sender', 'exception'],
      ['Not collected from DHL Locker, return to the sender', 'exception'],
      ['Shipment not collected by recipient, awaiting instructions', 'exception'],
      ['Collected by the recipient and returned to sender', 'returned'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
  });

  it('falls back without a rule id when nothing matches', () => {
    expect(classifyWording('Estado interno 99', 'pending')).toEqual({ stage: 'pending', source: 'none' });
    expect(wordingStage('Estado interno 99')).toBe('in_transit');
  });
});
