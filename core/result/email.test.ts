import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from './index.js';
import { namesEmail, withoutEmail } from './email.js';

describe('withoutEmail', () => {
  it.each([
    ['Predict information sent to: someone@example.com', 'Predict information sent'],
    ['Predict information sent to someone@example.com.', 'Predict information sent.'],
    ['Notification e-mail (j***n@example.co.uk) sent', 'Notification e-mail sent'],
    ['Recipient notified <someone.name+tag@example.com>, delivery planned', 'Recipient notified, delivery planned'],
    ['Delivered. For delivery questions, contact us at +1 000 000 0000 or support@example.com', 'Delivered. For delivery questions, contact us at +1 000 000 0000'],
    ['Delivery failed. For assistance, please contact us at support@example.com or.', 'Delivery failed. For assistance, please contact us.'],
    ['Delivery failed. For assistance, please contact us at or support@example.com.', 'Delivery failed. For assistance, please contact us.'],
    ['Attempted (please e-mail support@example.com to arrange redelivery)', 'Attempted (please e-mail to arrange redelivery)'],
    ['Delivery failed. Please contact us at support@example.com or +1 000 000 0000', 'Delivery failed. Please contact us +1 000 000 0000'],
    ['投递失败，请联系当地，邮箱：someone@example.com', '投递失败，请联系当地'],
    ['Handed over, e-mail: someone@example.com', 'Handed over'],
    ['Example Town someone779@example.com0100', 'Example Town 0100'],
    ['someone@example.com', ''],
  ])('drops the address in %j', (text, expected) => {
    expect(withoutEmail(text)).toBe(expected);
    expect(namesEmail(text)).toBe(true);
  });

  it.each([
    'Delivered to the recipient',
    'Arrived @ Example Hub',
    'Handed over to @partner',
    'Scan at hub@ 10:00',
    'Contact us at support@example',
  ])('keeps %j', (text) => {
    expect(withoutEmail(text)).toBe(text);
    expect(namesEmail(text)).toBe(false);
  });

  it('reads long runs of spaces in linear time', () => {
    const text = `${' '.repeat(5000)}x support@example.com`;
    const started = performance.now();
    expect(withoutEmail(text)).toBe('x');
    expect(withoutEmail(`a${' '.repeat(5000)}b @ c`)).toBe(`a${' '.repeat(5000)}b @ c`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('a result naming an e-mail address', () => {
  it('drops it from scan words and status text, and drops a place naming one', () => {
    const result = normalizeCarrierResult({
      status: 'in_transit',
      last_status_text: 'Predict information sent to: someone@example.com',
      events: [
        { time: '2026-05-01T10:00:00Z', description: 'Predict information sent to: someone@example.com', original_description: 'someone@example.com' },
        { time: '2026-05-01T09:00:00Z', description: 'Arrived at depot', location: 'Example Town,Example Area Someone779@example.com0100' },
        { time: '2026-05-01T08:00:00Z', description: 'Arrived at hub', location: 'Example Town' },
      ],
    });
    expect(result.last_status_text).toBe('Predict information sent');
    const events = result.events ?? [];
    expect(events[0]).toEqual({ time: '2026-05-01T10:00:00Z', description: 'Predict information sent' });
    expect(events[1]).not.toHaveProperty('location');
    expect(events[2]).toMatchObject({ location: 'Example Town' });
    expect(JSON.stringify(result)).not.toContain('@');
  });
});
