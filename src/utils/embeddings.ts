export function bytesToFloat32(bytes: number[]): Float32Array {
  // Embeddings stored as raw little-endian f32 bytes; interpret directly.
  const buf = new ArrayBuffer(bytes.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) u8[i] = bytes[i];
  const dv = new DataView(buf);
  const floats = new Float32Array(bytes.length / 4);
  for (let i = 0; i < floats.length; i++) floats[i] = dv.getFloat32(i * 4, true);
  return floats;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
