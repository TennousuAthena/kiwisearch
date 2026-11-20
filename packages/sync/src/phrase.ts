import { BIP39_WORDLIST, BIP39_WORD_INDEX } from './wordlist';
import { toArrayBufferView } from './encoding';

export const ENTROPY_BYTES = 32;
export const PHRASE_WORD_COUNT = 24;

export function normalizePhrase(input: string): string[] {
  return input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export async function entropyToPhrase(entropy: Uint8Array): Promise<string> {
  if (entropy.byteLength !== ENTROPY_BYTES) {
    throw new Error(`Expected ${ENTROPY_BYTES} bytes of entropy, got ${entropy.byteLength}`);
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBufferView(entropy)));
  const checksumByte = hash[0]!;

  // 256 bits entropy + 8 bits checksum = 264 bits = 24 * 11-bit word indices.
  const bits = new Uint8Array(ENTROPY_BYTES + 1);
  bits.set(entropy, 0);
  bits[ENTROPY_BYTES] = checksumByte;

  const words: string[] = [];
  for (let w = 0; w < PHRASE_WORD_COUNT; w++) {
    const bitStart = w * 11;
    let index = 0;
    for (let b = 0; b < 11; b++) {
      const bitPos = bitStart + b;
      const byteVal = bits[bitPos >> 3]!;
      const bit = (byteVal >> (7 - (bitPos & 7))) & 1;
      index = (index << 1) | bit;
    }
    words.push(BIP39_WORDLIST[index]!);
  }
  return words.join(' ');
}

export async function phraseToEntropy(phrase: string): Promise<Uint8Array<ArrayBuffer>> {
  const words = normalizePhrase(phrase);
  if (words.length !== PHRASE_WORD_COUNT) {
    throw new Error(`Recovery phrase must have ${PHRASE_WORD_COUNT} words, got ${words.length}`);
  }
  const indices: number[] = [];
  for (const word of words) {
    const idx = BIP39_WORD_INDEX.get(word);
    if (idx === undefined) throw new Error(`Unknown recovery phrase word: "${word}"`);
    indices.push(idx);
  }

  const bits = new Uint8Array(new ArrayBuffer(ENTROPY_BYTES + 1));
  for (let w = 0; w < PHRASE_WORD_COUNT; w++) {
    const idx = indices[w]!;
    const bitStart = w * 11;
    for (let b = 0; b < 11; b++) {
      const bit = (idx >> (10 - b)) & 1;
      const bitPos = bitStart + b;
      if (bit) bits[bitPos >> 3]! |= 1 << (7 - (bitPos & 7));
    }
  }

  const entropy = new Uint8Array(new ArrayBuffer(ENTROPY_BYTES));
  entropy.set(bits.subarray(0, ENTROPY_BYTES));
  const expectedChecksum = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy))[0]!;
  if (bits[ENTROPY_BYTES] !== expectedChecksum) {
    throw new Error('Recovery phrase checksum mismatch');
  }
  return entropy;
}

export async function validatePhrase(phrase: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await phraseToEntropy(phrase);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateRecoveryPhrase(): Promise<{ phrase: string; entropy: Uint8Array<ArrayBuffer> }> {
  const entropy = new Uint8Array(new ArrayBuffer(ENTROPY_BYTES));
  crypto.getRandomValues(entropy);
  const phrase = await entropyToPhrase(entropy);
  return { phrase, entropy };
}
