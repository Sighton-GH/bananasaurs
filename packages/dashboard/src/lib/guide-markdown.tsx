import type { ReactNode } from 'react';
import { Link } from 'wouter';

/**
 * The light Markdown the guide uses (ADR 0133): paragraphs separated by a blank
 * line, `- ` bullet lines, `code`, **bold**, and [label](/path) links to
 * dashboard pages. Nothing else is interpreted: unknown syntax stays as typed,
 * and text is never parsed as HTML. An absolute or other link shows its label.
 */

// A link target may hold one level of parentheses, so [x](javascript:f(1)) is one link.
// INLINE has one capture group, so `split` keeps each matched token at an odd index.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\))/;
const LINK = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)$/;

// A backslash is not internal either: browsers read "/\host" as "//host", a web address.
const isInternalPath = (target: string): boolean =>
  target.startsWith('/') && !target.startsWith('//') && !target.includes('\\');

const renderInline = (text: string): ReactNode[] =>
  text.split(INLINE).map((part, index) => {
    if (index % 2 === 0) return part;
    if (part.startsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const [, label = '', target = ''] = LINK.exec(part) ?? [];
    return isInternalPath(target) ? (
      <Link key={index} href={target}>
        {label}
      </Link>
    ) : (
      label
    );
  });

export const renderGuideMarkdown = (text: string): ReactNode => {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(<p key={blocks.length}>{renderInline(paragraph.join(' '))}</p>);
    paragraph = [];
  };
  const flushBullets = (): void => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={blocks.length}>
        {bullets.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flushParagraph();
      flushBullets();
    } else if (line.startsWith('- ')) {
      flushParagraph();
      bullets.push(line.slice(2));
    } else {
      flushBullets();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushBullets();
  return blocks;
};
