// Kept out of the entry module: a Worker's entry may export only handlers and classes.

export const PROTOCOL = 1;

export const LIMITS = {
  /** Largest binary frame. Signaling frames are 1564 bytes; the margin leaves room for relaying encrypted records later. */
  frameBytes: 16_384,
  /** Sockets in one topic, i.e. devices of one group online at the same time. */
  socketsPerTopic: 8,
  /** Frames one socket may send per window before it is closed. */
  framesPerWindow: 100,
  windowMs: 10_000,
} as const;
