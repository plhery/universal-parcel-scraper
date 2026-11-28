import { describe, expect, it } from 'vitest';
import { hasPrivateDeliveryDetails } from './private.js';

describe('private delivery details', () => {
  it.each([
    'Delivered by Mailbox, PIN: 4821',
    'Out for delivery, PIN 4821',
    'Your order is on the way. Share OTP with the rider',
    'OTP is 482193',
    'Delivered with one-time password',
    'Ready at the point, passcode 000000',
    'Delivery code 4821 sent to the recipient',
    '快件已到达驿站，取件码：12-3-4567',
    '快件已到達驛站，取件碼：12-3-4567',
    '包裹已到達自提點，提貨碼 482193',
    '請憑驗證碼 4821 取件',
    'Code de livraison : 4821',
    'Teslimat kodu 4821',
    'Signed for by A. EXAMPLE',
    'Door number 12',
    'Abholcode 123456',
    'Delivered Example Residence, Esc 1 porte 2',
    'Livré escalier 3, porte 12',
  ])('finds them in "%s"', (text) => {
    expect(hasPrivateDeliveryDetails(text)).toBe(true);
  });

  it.each([
    'Delivered',
    'Recibido por Estafeta',
    'Arrived at the hub, PIN code area 110001',
    'Firma Example GmbH',
    'Shipping label created',
    'Arrived at Porte de Example hub',
  ])('finds none in "%s"', (text) => {
    expect(hasPrivateDeliveryDetails(text)).toBe(false);
  });
});
