import { PageHeader } from '../ui/PageHeader.js';
import { NotFound } from '../ui/states.js';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" purpose="There is no page at this address." />
      <NotFound what="This page" backHref="/" backLabel="Go to the overview" />
    </>
  );
}
