import { GUIDE_TOPICS, type GuideTopic } from '@bananasaurs/core';
import { Link } from '../ui/Link.js';
import { renderGuideMarkdown } from '../lib/guide-markdown.js';
import { PageHeader } from '../ui/PageHeader.js';

/** The guide's nav groups, in the order their first topic appears (ADR 0133). */
const GROUPS: readonly { readonly label: string; readonly topics: readonly GuideTopic[] }[] = [
  ...new Set(GUIDE_TOPICS.map((topic) => topic.group)),
].map((label) => ({ label, topics: GUIDE_TOPICS.filter((topic) => topic.group === label) }));

function NavGroup({
  label,
  topics,
}: {
  readonly label: string;
  readonly topics: readonly GuideTopic[];
}) {
  return (
    <div className="mb-4">
      <p className="mb-1 text-caption font-semibold tracking-wider text-ink-muted uppercase">
        {label}
      </p>
      <ul className="space-y-0.5 border-l border-line">
        {topics.map((topic) => (
          <li key={topic.id}>
            <a
              href={`#${topic.id}`}
              className="-ml-px block border-l-2 border-transparent py-0.5 pl-3 text-small text-ink-muted hover:border-accent hover:text-accent"
            >
              {topic.title}
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
      <PageHeader title="Guide" purpose="How Bananasaurs works, topic by topic." />
      <div className="rounded-panel border border-line bg-panel p-4 sm:p-6 md:flex md:gap-8">
        <nav aria-label="Guide sections" className="mb-6 md:mb-0 md:w-44 md:shrink-0">
          <div className="md:sticky md:top-5">
            {GROUPS.map((group) => (
              <NavGroup key={group.label} label={group.label} topics={group.topics} />
            ))}
          </div>
        </nav>
        <div className="min-w-0 max-w-2xl flex-1">
          {GROUPS.map((group) => (
            <div key={group.label} className="mb-8">
              <h2 className="mb-3 text-section font-semibold">{group.label}</h2>
              {group.topics.map((topic, index) => (
                <section
                  id={topic.id}
                  key={topic.id}
                  className={index === 0 ? 'pb-5' : 'border-t border-line py-5'}
                >
                  <h3 className="mb-1 text-small font-semibold">{topic.title}</h3>
                  <p className="mb-2 text-small text-ink-muted">{topic.summary}</p>
                  <div className="text-small [&_a]:text-accent [&_a]:underline [&_code]:rounded-sm [&_code]:border [&_code]:border-line [&_code]:px-1 [&_code]:text-caption [&_p+p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
                    {renderGuideMarkdown(topic.body)}
                  </div>
                  {topic.seeAlso !== undefined && topic.seeAlso.length > 0 && (
                    <p className="mt-2 text-small">
                      See also:{' '}
                      {topic.seeAlso.map((link, position) => (
                        <span key={link.path}>
                          {position > 0 && ', '}
                          <Link href={link.path}>{link.label}</Link>
                        </span>
                      ))}
                    </p>
                  )}
                </section>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
