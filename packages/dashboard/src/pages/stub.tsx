import { PageHeader } from '../ui/PageHeader.js';

export interface StubPageProps {
  readonly title: string;
  /** One sentence: what this area will be. */
  readonly purpose: string;
  /** Ruling S10-D3: only Archive and Search set this. */
  readonly availableToday?: string | undefined;
}

export const NOT_BUILT = 'Not built. Planned for Release 3.';

/** Release 3 placeholder (S10-D2): a title, one sentence, and the not-built statement. Makes no API call. */
export function StubPage(props: StubPageProps) {
  return (
    <>
      <PageHeader title={props.title} purpose={props.purpose} />
      <p className="text-sm">{NOT_BUILT}</p>
      {props.availableToday !== undefined && <p className="mt-2 text-sm">{props.availableToday}</p>}
    </>
  );
}
