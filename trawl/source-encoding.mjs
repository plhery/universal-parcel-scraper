// A quote-free basE91 alphabet keeps Coolify's outer base64 SSH argument bounded.
export const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#,;_`|~';
export function encodeSource(bytes) {
  let result = '', bits = 0, queue = 0;
  for (const byte of bytes) {
    queue |= byte << bits; bits += 8;
    if (bits > 13) {
      let value = queue & 8191;
      if (value > 88) { queue >>>= 13; bits -= 13; }
      else { value = queue & 16383; queue >>>= 14; bits -= 14; }
      result += alphabet[value % 91] + alphabet[Math.floor(value / 91)];
    }
  }
  if (bits) {
    result += alphabet[queue % 91];
    if (bits > 7 || queue > 90) result += alphabet[Math.floor(queue / 91)];
  }
  return result;
}
// Self-contained so the renderer can install these exact decoding instructions.
export function decodeSource(text, length, alphabet) {
  if (!Number.isSafeInteger(length) || length < 0 || length > text.length * 2) throw new Error('Invalid source archive');
  const bytes = Buffer.alloc(length);
  let queue = 0, bits = 0, value = -1, written = 0;
  for (const character of text) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid source archive');
    if (value < 0) { value = digit; continue; }
    value += digit * 91;
    queue |= value << bits; bits += (value & 8191) > 88 ? 13 : 14;
    while (bits > 7) {
      if (written >= length) throw new Error('Invalid source archive');
      bytes[written++] = queue & 255; queue >>>= 8; bits -= 8;
    }
    value = -1;
  }
  if (value >= 0) {
    if (written >= length) throw new Error('Invalid source archive');
    bytes[written++] = (queue | value << bits) & 255;
  }
  if (written !== length) throw new Error('Invalid source archive');
  return bytes;
}
