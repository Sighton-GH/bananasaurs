import { Link } from 'wouter';
import { PageHeader } from '../ui/PageHeader.js';

type DocSection = {
  readonly id: string;
  readonly title: string;
  readonly body: React.ReactNode;
};

const statusFlow = ['Not started', 'In progress', 'Awaiting approval', 'Done'] as const;

const visibilityRows = [
  { who: 'Team member', sees: "Their team's tasks, in Discord" },
  { who: 'Exec member', sees: "The exec team's tasks, in Discord" },
  { who: 'Owner', sees: "Every team's board, here in the dashboard" },
] as const;

const taskSections: readonly DocSection[] = [
  {
    id: 'tasks',
    title: 'Tasks',
    body: (
      <>
        <p>
          A task is one piece of club work. It belongs to one team (a subteam or the exec team) and
          has a title, a due date, and a home channel or thread in that team's Discord category.
          Assign it to the whole team or to one person.
        </p>
        <p className="mt-2">
          Big tasks break into steps. Each step has its own date and shares the task's team and
          channel.
        </p>
      </>
    ),
  },
  {
    id: 'visibility',
    title: 'Who sees what',
    body: (
      <>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Who can see which task boards</caption>
          <tbody>
            {visibilityRows.map((row) => (
              <tr key={row.who} className="border-b border-line last:border-0">
                <th scope="row" className="py-1 pr-3 text-left font-medium whitespace-nowrap">
                  {row.who}
                </th>
                <td className="py-1 text-ink-muted">{row.sees}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2">
          The dashboard is owner-only, always. Members and execs work in Discord:{' '}
          <code>/task list</code>, <code>/task complete</code>, reminders and the weekly digest.
        </p>
      </>
    ),
  },
  {
    id: 'creating',
    title: 'Creating a task',
    body: (
      <p>
        The owner uses <Link href="/tasks/new">New task</Link> here, or an MCP client the owner has
        connected.
      </p>
    ),
  },
  {
    id: 'statuses',
    title: 'Statuses',
    body: (
      <>
        <ol className="flex flex-wrap items-center gap-1 text-xs">
          {statusFlow.map((label) => (
            <li
              key={label}
              className="flex items-center gap-1 not-first:before:mr-1 not-first:before:content-['→']"
            >
              <span className="rounded-sm border border-line px-1.5 py-0.5">{label}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2">
          Work moves forward as members report progress. Marking a task complete with{' '}
          <code>/task complete</code> in Discord means ready for review, not done.
        </p>
        <p className="mt-2">
          Members reply directly to the bot&apos;s task post, reminder, or weekly check-in. A reply
          with an update is saved; a reply like &apos;ok&apos; is not.
        </p>
      </>
    ),
  },
  {
    id: 'review',
    title: 'Review and approval',
    body: (
      <p>
        After <code>/task complete</code>, the bot posts a review request in the task&apos;s
        channel. The team lead (or the president, for exec tasks, or for any team) presses Approve
        or Send back.
      </p>
    ),
  },
  {
    id: 'keeping-records',
    title: 'Keeping records',
    body: (
      <p>
        Approved tasks are archived automatically with all their updates. Nothing is deleted unless
        the owner deletes a task or a single update on its page.
      </p>
    ),
  },
  {
    id: 'priorities',
    title: 'Priorities',
    body: (
      <p>
        Every task is <strong>normal</strong> or <strong>urgent</strong>. Urgent tasks are listed
        first on the board.
      </p>
    ),
  },
  {
    id: 'reminders',
    title: 'Reminders',
    body: (
      <p>
        The bot posts when a task is created, 48 hours before it is due, at any custom times, and in
        a weekly Monday check-in per channel or thread, pinging the assignees (or the team role).
        Each team&apos;s announcements channel gets a weekly digest. These posts go out only when
        the operator turns on task posts.
      </p>
    ),
  },
  {
    id: 'quiet-hours',
    title: 'Quiet hours',
    body: (
      <p>
        No reminders between midnight and 8 a.m. Pacific. Anything due overnight waits for the
        morning.
      </p>
    ),
  },
] as const;

const featureSections: readonly DocSection[] = [
  {
    id: 'moderation',
    title: 'Moderation',
    body: (
      <p>
        <Link href="/automod">Automod</Link> watches for rule-breaking messages.{' '}
        <Link href="/review">Review</Link> shows what rules matched so they can be tuned,{' '}
        <Link href="/cases">Cases</Link> keeps each incident, and{' '}
        <Link href="/members">Members</Link> shows each person's history.{' '}
        <Link href="/cutover">Turn on moderation</Link> takes a rule live only after review.
      </p>
    ),
  },
  {
    id: 'messages',
    title: 'Messages and archive',
    body: (
      <p>
        <Link href="/permissions">Permissions</Link> decides which channels the bot may read, post
        in or archive. <Link href="/archive">Archive</Link> keeps a searchable copy of messages and{' '}
        <Link href="/search">Search</Link> finds them. <Link href="/logging">Logging</Link> routes
        server events to the channels you choose.
      </p>
    ),
  },
  {
    id: 'assistant',
    title: 'Assistant',
    body: (
      <p>
        <Link href="/assistant/setup">AI setup</Link> picks the models and connects the services
        they need. <Link href="/assistant">Behaviours</Link> set who the assistant answers and how
        it sounds. <Link href="/assistant/skills">Skills</Link>,{' '}
        <Link href="/assistant/resources">Resources</Link>,{' '}
        <Link href="/assistant/schedules">Schedules</Link> and <Link href="/memory">Memory</Link>{' '}
        control what it can do, read and remember.{' '}
        <Link href="/assistant/conversations">Conversations</Link> and{' '}
        <Link href="/assistant/history">History</Link> show what it actually said.
      </p>
    ),
  },
  {
    id: 'server',
    title: 'Server',
    body: (
      <p>
        <Link href="/panels">Self-granted roles</Link> let members pick roles with a reaction,
        button or dropdown. <Link href="/safety">Safety</Link> is the kill switch: it stops every
        Discord side effect at once.
      </p>
    ),
  },
  {
    id: 'system',
    title: 'System',
    body: (
      <p>
        <Link href="/">Overview</Link> shows connection health and what needs a decision.{' '}
        <Link href="/doctor">Doctor</Link> re-checks the Discord setup,{' '}
        <Link href="/jobs">Background tasks</Link> and <Link href="/audit">Audit</Link> show the
        work, <Link href="/backups">Backups</Link> and <Link href="/config">Configuration</Link>{' '}
        keep it running, <Link href="/accounts">Accounts</Link> controls who can sign in, and{' '}
        <Link href="/mcp">Connected apps</Link> manages MCP access.
      </p>
    ),
  },
] as const;

const groups = [
  { label: 'Task tracking', sections: taskSections },
  { label: 'Everything else', sections: featureSections },
] as const;

function NavGroup({
  label,
  sections,
}: {
  readonly label: string;
  readonly sections: readonly DocSection[];
}) {
  return (
    <div className="mb-4">
      <p className="mb-1 text-xs font-semibold tracking-wider text-ink-muted uppercase">{label}</p>
      <ul className="space-y-0.5 border-l border-line">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="-ml-px block border-l-2 border-transparent py-0.5 pl-3 text-sm text-ink-muted hover:border-blue-500 hover:text-blue-700"
            >
              {s.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DocsPage() {
  return (
    <>
      <PageHeader
        title="Guide"
        purpose="A short tour of Bananasaurs: tasks first, then every other area."
      />
      <div
        className="mb-6 max-w-3xl rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-slate-800"
        role="status"
      >
        Discord posts (announcements, reminders, review requests) go out only when the operator
        turns on task posts. The dashboard itself is owner-only by design.
      </div>
      <div className="rounded-md border border-line bg-panel p-4 sm:p-6 md:flex md:gap-8">
        <nav aria-label="Guide sections" className="mb-6 md:mb-0 md:w-44 md:shrink-0">
          <div className="md:sticky md:top-5">
            {groups.map((g) => (
              <NavGroup key={g.label} label={g.label} sections={g.sections} />
            ))}
          </div>
        </nav>
        <div className="min-w-0 max-w-2xl flex-1">
          {groups.map((g) => (
            <div key={g.label} className="mb-8">
              <h2 className="mb-3 text-base font-semibold">{g.label}</h2>
              {g.sections.map((s, i) => (
                <section
                  id={s.id}
                  key={s.id}
                  className={i === 0 ? 'pb-5' : 'border-t border-line py-5'}
                >
                  <h3 className="mb-1 text-sm font-semibold">{s.title}</h3>
                  <div className="text-sm [&_a]:text-blue-700 [&_a]:underline">{s.body}</div>
                </section>
              ))}
            </div>
          ))}
          <p className="text-sm">
            <Link href="/tasks" className="text-blue-700 underline">
              Open Tasks
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
