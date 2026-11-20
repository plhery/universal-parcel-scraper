import { describe, expect, it } from 'vitest';
import { botDetectAnswer, botDetectCase, botDetectInstance } from './botdetect.js';

// Hidden fields as Jetizz's tracker form gives them, with an instance whose picture read "SEC6".
const FORM = `<input type="hidden" name="BDC_VCID_ExampleCaptcha" id="BDC_VCID_ExampleCaptcha" value="3c6db0da24a148f89fadb99525a0b984" />
<input type="hidden" name="BDC_BackWorkaround_ExampleCaptcha" id="BDC_BackWorkaround_ExampleCaptcha" value="0" />
<input type="hidden" name="BDC_Hs_ExampleCaptcha" id="BDC_Hs_ExampleCaptcha" value="89a8439d7f3acb9c43500670ce8d1fadb72a69c7" />
<input type="hidden" name="BDC_SP_ExampleCaptcha" id="BDC_SP_ExampleCaptcha" value="1142667381" />`;

describe('BotDetect answers', () => {
  it('reads an instance and its counter search from the form, in any attribute order', () => {
    expect(botDetectInstance(FORM, 'ExampleCaptcha')).toEqual({ id: '3c6db0da24a148f89fadb99525a0b984',
      hash: '89a8439d7f3acb9c43500670ce8d1fadb72a69c7', start: 1142667381 });
    const plain = '<input value="5f84225a065d4a40a97b7a9c0b4f02c6" id="BDC_VCID_Other" type="hidden" name="BDC_VCID_Other">';
    expect(botDetectInstance(plain, 'Other')).toEqual({ id: '5f84225a065d4a40a97b7a9c0b4f02c6' });
    expect(botDetectInstance(FORM, 'Other')).toBeNull();
    expect(botDetectInstance(FORM.replace('3c6db0da', 'zzzzzzzz'), 'ExampleCaptcha')).toBeNull();
    expect(() => botDetectInstance(FORM, 'Example"Captcha')).toThrow(TypeError);
  });

  it('sets each character\'s case from the counter as the form\'s script types it', async () => {
    // The tracker accepted "SEc6" for this instance.
    expect(await botDetectAnswer('SEC6', botDetectInstance(FORM, 'ExampleCaptcha')!)).toBe('SEc6');
    // 159296366 % 65533 + 1 is 51177, 1100011111101001 in binary: its last four bits set J, c, 4 and 4.
    expect(botDetectCase('JC44', 159296366)).toBe('Jc44');
    // Characters left of the mask's bits are typed small.
    expect(botDetectCase('ABCD', 65533)).toBe('abcD');
    expect(botDetectCase('ABCD', 65535)).toBe('abCD');
  });

  it('keeps the code on a form without a counter, and answers null when no counter matches', async () => {
    expect(await botDetectAnswer('SEC6', { id: '3c6db0da24a148f89fadb99525a0b984' })).toBe('SEC6');
    expect(await botDetectAnswer('SEC6', { id: '3c6db0da24a148f89fadb99525a0b984', hash: '0'.repeat(40), start: 2 ** 31 - 20 })).toBeNull();
    const aborted = AbortSignal.abort();
    await expect(botDetectAnswer('SEC6', { id: '3c6db0da24a148f89fadb99525a0b984', hash: '0'.repeat(40), start: 0 }, aborted)).rejects.toThrow();
  });
});
