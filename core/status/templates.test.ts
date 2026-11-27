import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import vocabulary from '../../data/scan-templates.json' with { type: 'json' };
import { SCAN_TEMPLATE_KEYS } from '../../generated/scanTemplates.js';
import { normalizeStatusWording } from './statusMap.js';
import { scanTemplate } from './templates.js';

const root = path.resolve(import.meta.dirname, '../..');
const templates: Record<string, { stage: string; text: Record<string, string> }> = vocabulary.templates;

describe('scan templates', () => {
  it('gives every template its text in each language the app shows, and one template each text', () => {
    expect(vocabulary.languages).toEqual(['en', 'de', 'fr', 'it', 'es', 'pt', 'pt-br', 'pl', 'ru', 'zh']);
    for (const language of vocabulary.languages) {
      const texts = Object.values(templates).map((template) => template.text[language]);
      expect(texts.every((text) => typeof text === 'string' && text.length > 0 && text === text.trim()), language).toBe(true);
      expect(new Set(texts).size, language).toBe(texts.length);
    }
  });

  it('keys wording in the form the app looks it up in', () => {
    for (const keys of Object.values(SCAN_TEMPLATE_KEYS)) {
      for (const wording of Object.keys(keys.wordings ?? {})) expect(normalizeStatusWording(wording)).toBe(wording);
    }
  });

  it('names only templates the vocabulary holds', () => {
    const named = readdirSync(path.join(root, 'carriers')).flatMap((carrier) => {
      const file = path.join(root, 'carriers', carrier, 'statuses.json');
      if (!existsSync(file)) return [];
      const { entries } = JSON.parse(readFileSync(file, 'utf8')) as { entries: { template?: string }[] };
      return entries.flatMap((entry) => (entry.template ? [entry.template] : []));
    });
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((id) => !Object.hasOwn(templates, id))).toEqual([]);
  });

  it('reads a scan by its wording, apart from case and spacing', () => {
    expect(scanTemplate('js-express', { description: '  Item has been  COLLECTED ' }))
      .toEqual({ id: 'picked_up', language: 'en' });
    expect(scanTemplate('dhl', { description: 'Die Sendung wurde erfolgreich zugestellt.' }))
      .toEqual({ id: 'delivered', language: 'de' });
  });

  it('reads a scan by a code whose entry has no wording, or a wording with a placeholder', () => {
    expect(scanTemplate('ups', { providerCode: 'AR', description: 'Arrived at Facility' }))
      .toEqual({ id: 'arrived_facility', language: 'en' });
    expect(scanTemplate('vinted-go', { providerCode: 'delivery/in_transit', description: 'At sorting center in Lille, France' }))
      .toEqual({ id: 'at_sorting_center', language: 'en' });
  });

  it('names no template for a scan its carrier left out, or another carrier', () => {
    expect(scanTemplate('js-express', { description: 'During security check operation' })).toBeUndefined();
    expect(scanTemplate('la-poste', { description: 'Delivered' })).toBeUndefined();
    expect(scanTemplate('not-a-carrier', { description: 'Delivered' })).toBeUndefined();
  });
});
