import type { CarrierResult } from '../../core/result/index.js';
import { dateWallClocks } from './gofo-rows.js';

// J&T Express Mexico's rows, which trackers copy on a line into Mexico: its sentence after the town and
// the site in brackets, "【Town】Tu envío ha salido de【SITE.pdv】con destino a【MEXICO.sc】".
const JT_MEXICO_ROW = /【[^【】]{1,80}】\s*(?:【[^【】]{1,80}】\s*)?(?:tu envío\b|[¡?]?recolección exitosa\b|el mensajero de j&t\b)/i;
const BRACKETED = /【[^【】]{1,80}】/g;
// Its collection names the courier and J&T's phone, and the platform's GBK turns its "¡" into "?".
const JT_MEXICO_COLLECTION = /^((?:【…】){1,2})[¡?]?(recolección exitosa!\. el mensajero de j&t asignado )\S.*?( recolectó tu envío\.).*$/;
// So does its round to the recipient's home: "El mensajero de J&T Express … está en camino a tu domicilio. Si requieres …".
const JT_MEXICO_ROUND = /^((?:【…】){1,2})(el mensajero de j&t express )\S.*?( está en camino a tu domicilio\.).*$/;

/** Whether a row is one J&T Express Mexico wrote that a tracker copies, on J&T's clock in Mexico. */
export const isJtMexicoRow = (wording: string): boolean => JT_MEXICO_ROW.test(wording);

/**
 * A J&T Express Mexico row's key, by its `normalizeStatusWording` wording: its towns and sites, and the courier
 * and phone of its collection and round, as ellipses. Another row's wording is its own key.
 */
export const jtMexicoKey = (wording: string): string => (JT_MEXICO_ROW.test(wording)
  ? wording.replace(BRACKETED, '【…】').replace(JT_MEXICO_COLLECTION, '$1¡$2…$3').replace(JT_MEXICO_ROUND, '$1$2…$3') : wording);

// J&T Express Mexico writes its scans on Mexico City's clock, as its own tracker answers them.
const JT_MEXICO_ZONE = 'America/Mexico_City';

/** The result with the rows a tracker copies from J&T Express Mexico, read as wall clocks, dated on J&T's clock. */
export const dateJtMexicoRows = (result: CarrierResult): CarrierResult => dateWallClocks(result,
  (event) => (isJtMexicoRow(event.description ?? '') ? { zone: JT_MEXICO_ZONE, basis: 'carrier' } : null));
