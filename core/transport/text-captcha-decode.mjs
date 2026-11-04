import characters from './text-captcha-model/characters.json' with { type: 'json' };

/** @param {Record<number, string>} alphabet */
export function decodeTextCaptchaLogits(data, dims, alphabet = characters) {
  if (dims.length !== 3 || dims[0] < 1 || dims[0] > 64 || dims[1] !== 1 || dims[2] !== 8210 || data.length !== dims[0] * 8210) {
    throw new Error('Invalid OCR tensor');
  }
  let previous = -1, answer = '';
  for (let step = 0; step < dims[0]; step++) {
    let best = 0;
    for (let column = 0; column < 8210; column++) {
      const value = data[step * 8210 + column];
      if (!Number.isFinite(value)) throw new Error('Invalid OCR score');
      if (value > data[step * 8210 + best]) best = column;
    }
    if (best !== previous && best !== 0) {
      const character = alphabet[best];
      if (!character) return '';
      answer += character;
    }
    previous = best;
  }
  return answer;
}
