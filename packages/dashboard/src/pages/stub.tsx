import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { PageHeader } from '../ui/PageHeader.js';

export interface StubPageProps {
  readonly title: string;
  /** One sentence: what this area will be. */
  readonly purpose: string;
  /** Set when part of the area already exists somewhere else (the CLI, the MCP connector). */
  readonly availableToday?: string | undefined;
}

export const NOT_BUILT = 'Not built. Planned for Release 3.';

/**
 * Release 3 placeholder (ADR 0051 D6b): the roadmap stays visible without the
 * UI pretending anything exists. A title, one purpose sentence and the plain
 * not-built statement, styled like every other page — and still no API call.
 */
export function StubPage(props: StubPageProps) {
  return (
    <>
      <PageHeader title={props.title} purpose={props.purpose} />
      <div className="max-w-2xl">
        <Card title="Where this stands">
          <p className="mb-2">
            <Badge tone="neutral">Release 3</Badge>
          </p>
          <p className="text-sm">{NOT_BUILT}</p>
          {props.availableToday !== undefined && (
            <p className="mt-2 text-sm">{props.availableToday}</p>
          )}
        </Card>
      </div>
    </>
  );
}
