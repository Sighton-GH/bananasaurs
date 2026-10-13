/**
 * Card art (ADR 0140 decision 4). The bytes live in
 * `apps/daemon/assets/cards/` and are attached to each message that uses
 * them; a card names art by key and links it as `attachment://<file>`.
 */
export const ART = {
  saurThumb: { file: 'saur-thumb.png', alt: 'The Bananasaurs banana-saur' },
  bannerTasks: {
    file: 'banner-tasks.png',
    alt: 'The banana-saur beside banana leaves on a warm yellow background',
  },
  bannerDigest: {
    file: 'banner-digest.png',
    alt: 'The banana-saur beside banana leaves on a soft green background',
  },
  bannerPanel: {
    file: 'banner-panel.png',
    alt: 'The banana-saur beside banana leaves on a navy background',
  },
} as const;
export type ArtKey = keyof typeof ART;

export const artUrl = (key: ArtKey): string => `attachment://${ART[key].file}`;
