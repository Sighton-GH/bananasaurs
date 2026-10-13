import { Card } from '../../ui/Card.js';
import { Link } from '../../ui/Link.js';

export function AssistantPermissions() {
  return (
    <Card title="Assistant permissions">
      <p className="text-body">
        Who may tag the assistant and which skills each role/member may use are permission-bearing
        controls. Manage them on the Behaviours page, where the live role and member directories
        prevent raw-ID mistakes.
      </p>
      <Link href="/assistant" className="mt-2 inline-block text-body ">
        Open Behaviours
      </Link>
    </Card>
  );
}
