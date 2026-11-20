import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChallengeError, NotFoundError } from '../../core/errors/index.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.json', import.meta.url), 'utf8');

describe('Relay Express docket tracking', () => {
  it('reads delivery and its scan clock without opening proof attachments', () => {
    const result = parseTracking(found, '24VJWD3700135');
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2025-08-28T17:57:00' });
    expect(result.events).toHaveLength(14);
    expect(result.events?.[0]?.location).toBe('RUDRAPUR');
  });

  it('preserves the distinction between a missing docket, a challenge and another docket', () => {
    expect(() => parseTracking(missing, '24VJWD9999999')).toThrow(NotFoundError);
    expect(() => parseTracking('{"success":false,"message":"Captcha is required"}', '24VJWD3700135')).toThrow(ChallengeError);
    expect(() => parseTracking(found, '24VJWD9999999')).toThrow(/another docket/i);
  });
});
