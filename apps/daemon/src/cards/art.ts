import { readFileSync } from 'node:fs';
import {
  ART,
  toOutgoingMessage,
  type ArtKey,
  type CardMessage,
  type OutgoingFile,
  type OutgoingMessage,
} from '@bananasaurs/core';

/** `apps/daemon/assets/cards/`, from both `src/cards/` and `dist/cards/`. */
const ASSET_DIR = new URL('../../assets/cards/', import.meta.url);
const cache = new Map<ArtKey, OutgoingFile>();

/** Card art bytes (ADR 0140 decision 4), read once per process. */
export const loadArt = (key: ArtKey): OutgoingFile => {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const entry = ART[key];
  const file: OutgoingFile = {
    name: entry.file,
    contentType: 'image/png',
    data: new Uint8Array(readFileSync(new URL(entry.file, ASSET_DIR))),
    description: entry.alt,
  };
  cache.set(key, file);
  return file;
};

/** A card as a port message, with its art attached. */
export const cardOut = (message: CardMessage): OutgoingMessage =>
  toOutgoingMessage(message, loadArt);
