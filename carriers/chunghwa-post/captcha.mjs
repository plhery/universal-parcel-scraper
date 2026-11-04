/** Remove long background rules, interpolating across them to retain crossing strokes. */
export function removeChunghwaGrid(pixels, width, height) {
  if (width !== 162 || height !== 54 || pixels.length !== width * height) throw new Error('unsupported-image');
  const rows = Array.from({ length: height }, (_, y) => {
    let dark = 0;
    for (let x = 0; x < width; x++) if (pixels[y * width + x] < 140) dark++;
    return dark > width * 0.7;
  });
  const columns = Array.from({ length: width }, (_, x) => {
    let dark = 0;
    for (let y = 0; y < height; y++) if (pixels[y * width + x] < 140) dark++;
    return dark > height * 0.8;
  });
  const output = Uint8Array.from(pixels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!rows[y] && !columns[x]) continue;
    let top = y - 1, bottom = y + 1, left = x - 1, right = x + 1;
    while (top >= 0 && rows[top]) top--;
    while (bottom < height && rows[bottom]) bottom++;
    while (left >= 0 && columns[left]) left--;
    while (right < width && columns[right]) right++;
    output[y * width + x] = rows[y] && !columns[x] && top >= 0 && bottom < height
      ? (pixels[top * width + x] + pixels[bottom * width + x]) / 2
      : columns[x] && !rows[y] && left >= 0 && right < width
        ? (pixels[y * width + left] + pixels[y * width + right]) / 2 : 255;
  }
  return output;
}

/** Digit-only CTC, scored against every class so a weak digit remains uncertain. */
export function decodeChunghwaDigits(data, dims, alphabet) {
  if (dims.length !== 3 || dims[0] < 1 || dims[0] > 64 || dims[1] !== 1 || dims[2] !== 8210
    || data.length !== dims[0] * dims[2]) throw new Error('Invalid OCR tensor');
  const candidates = Object.keys(alphabet).map(Number).filter(index => index === 0 || /^\d$/.test(alphabet[index]));
  let previous = -1, answer = '', peak = 0;
  const peaks = [];
  for (let step = 0; step < dims[0]; step++) {
    const offset = step * dims[2];
    let best = 0;
    for (const index of candidates) if (data[offset + index] > data[offset + best]) best = index;
    if (best !== previous) {
      if (previous > 0) peaks.push(peak);
      peak = 0;
      if (best) answer += alphabet[best];
    }
    let sum = 0;
    for (let index = 0; index < dims[2]; index++) {
      const value = data[offset + index];
      if (!Number.isFinite(value)) throw new Error('Invalid OCR score');
      if (best) sum += Math.exp(value - data[offset + best]);
    }
    if (best) peak = Math.max(peak, 1 / sum);
    previous = best;
  }
  if (previous > 0) peaks.push(peak);
  return { answer, confidence: peaks.length ? peaks.reduce((sum, value) => sum + Math.log(value), 0) / peaks.length : -Infinity };
}
