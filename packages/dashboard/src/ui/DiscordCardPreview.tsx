import type { CSSProperties, ReactNode } from 'react';
import { renderDiscordMarkdown, safeHttpUrl, type DiscordClock } from '../lib/discord-markdown.js';

/**
 * A read-only preview of a Discord Components V2 card (ADR 0140). It walks the
 * wire JSON the card renderer produced and draws the supported pieces; it does
 * not render cards itself. Nothing in it acts: buttons are disabled, link
 * buttons are plain anchors, and the card art is a bundled stand-in looked up
 * by attachment name. A remote image address in the JSON is never loaded.
 */

/** Attachment file name to a bundled public image. */
export type CardArtRegistry = Readonly<Record<string, string>>;

export const DEFAULT_CARD_ART: CardArtRegistry = {
  'saur-thumb.png': '/brand/bananasaur.png',
  'banner-tasks.png': '/brand/leaves.svg',
  'banner-digest.png': '/brand/leaves.svg',
  'banner-panel.png': '/brand/leaves.svg',
};

export interface DiscordCardPreviewProps extends DiscordClock {
  readonly components: readonly unknown[];
  readonly art?: CardArtRegistry;
}

type Wire = Readonly<Record<string, unknown>>;
const isWire = (value: unknown): value is Wire =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const ATTACHMENT = /^attachment:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

interface Ctx extends DiscordClock {
  readonly art: CardArtRegistry;
}

const Art = ({
  media,
  alt,
  ctx,
  className,
}: {
  media: unknown;
  alt?: string | undefined;
  ctx: Ctx;
  className: string;
}) => {
  const url = isWire(media) ? str(media['url']) : undefined;
  const name = url === undefined ? undefined : ATTACHMENT.exec(url)?.[1];
  const src = name !== undefined && Object.hasOwn(ctx.art, name) ? ctx.art[name] : undefined;
  return src === undefined ? (
    <span className={`discord-art-missing ${className}`} data-art-fallback>
      {alt ?? 'Card art'}
    </span>
  ) : (
    <img className={className} src={src} alt={alt ?? 'Card art'} />
  );
};

const BUTTON_CLASS: Readonly<Record<number, string>> = {
  1: 'discord-btn-primary',
  2: 'discord-btn-secondary',
  3: 'discord-btn-success',
  4: 'discord-btn-danger',
  5: 'discord-btn-secondary',
};

const Button = ({ node, ctx }: { node: Wire; ctx: Ctx }): ReactNode => {
  const label = str(node['label']);
  const style = typeof node['style'] === 'number' ? node['style'] : 2;
  if (label === undefined) return null;
  const emoji = isWire(node['emoji']) ? str(node['emoji']['name']) : undefined;
  const content = emoji === undefined ? label : `${emoji} ${label}`;
  const className = `discord-btn ${BUTTON_CLASS[style] ?? 'discord-btn-secondary'}`;
  const href = style === 5 ? safeHttpUrl(str(node['url']) ?? '') : null;
  return href === null ? (
    <button type="button" className={className} disabled>
      {content}
    </button>
  ) : (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {content}
      {ctx.indicateExternalLinks === true && ' (opens in a new tab)'}
    </a>
  );
};

const Texts = ({ nodes, ctx }: { nodes: readonly unknown[]; ctx: Ctx }) =>
  nodes.map((n, i) =>
    isWire(n) && n['type'] === 10 && typeof n['content'] === 'string' ? (
      <div key={i} className="discord-text">
        {renderDiscordMarkdown(n['content'], ctx)}
      </div>
    ) : null,
  );

const Child = ({ node, ctx }: { node: unknown; ctx: Ctx }): ReactNode => {
  if (!isWire(node)) return null;
  switch (node['type']) {
    case 10:
      return <Texts nodes={[node]} ctx={ctx} />;
    case 14:
      return <hr className="discord-sep" />;
    case 12:
      return (
        <div className="discord-gallery">
          {list(node['items']).map((item, i) =>
            isWire(item) ? (
              <Art
                key={i}
                media={item['media']}
                alt={str(item['description'])}
                ctx={ctx}
                className="discord-gallery-img"
              />
            ) : null,
          )}
        </div>
      );
    case 9: {
      const accessory = isWire(node['accessory']) ? node['accessory'] : undefined;
      return (
        <div className="discord-section">
          <div className="discord-section-text">
            <Texts nodes={list(node['components'])} ctx={ctx} />
          </div>
          {accessory?.['type'] === 11 ? (
            <Art
              media={accessory['media']}
              alt={str(accessory['description'])}
              ctx={ctx}
              className="discord-thumb"
            />
          ) : accessory?.['type'] === 2 ? (
            <Button node={accessory} ctx={ctx} />
          ) : null}
        </div>
      );
    }
    case 1:
      return (
        <div className="discord-row">
          {list(node['components']).map((b, i) =>
            isWire(b) && b['type'] === 2 ? <Button key={i} node={b} ctx={ctx} /> : null,
          )}
        </div>
      );
    default:
      return null;
  }
};

const accentVar = (value: unknown): CSSProperties | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff
    ? ({ '--discord-accent': `#${value.toString(16).padStart(6, '0')}` } as CSSProperties)
    : undefined;

export const DiscordCardPreview = ({
  components,
  art = DEFAULT_CARD_ART,
  now,
  timeZone,
  userNames,
  indicateExternalLinks,
}: DiscordCardPreviewProps) => {
  const ctx: Ctx = {
    art,
    ...(userNames === undefined ? {} : { userNames }),
    ...(indicateExternalLinks === undefined ? {} : { indicateExternalLinks }),
    ...(now === undefined ? {} : { now }),
    ...(timeZone === undefined ? {} : { timeZone }),
  };
  return (
    <figure className="discord-preview">
      {components.map((top, index) =>
        isWire(top) && top['type'] === 17 ? (
          <div
            key={index}
            className="discord-card"
            data-discord-card
            role="group"
            aria-label="Discord card preview"
            style={accentVar(top['accent_color'])}
          >
            {list(top['components']).map((child, i) => (
              <Child key={i} node={child} ctx={ctx} />
            ))}
          </div>
        ) : (
          <Child key={index} node={top} ctx={ctx} />
        ),
      )}
      <figcaption className="discord-note">
        Art shown here is a stand-in; Discord shows the card art.
      </figcaption>
    </figure>
  );
};
