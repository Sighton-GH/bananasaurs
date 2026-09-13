import { Link } from 'wouter';
import { PageHeader } from '../ui/PageHeader.js';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" purpose="There is no page at this address." />
      <p className="text-sm">
        <Link href="/" className="underline">
          Go to the overview
        </Link>
      </p>
    </>
  );
}
