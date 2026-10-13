import { describe, expect, it } from 'vitest';
import { CAPABILITY_INFO } from '../account-roles.js';
import { MCP_SCOPE_INFO } from '../ops/mcp-scopes.js';
import { findGuideTopic, GUIDE_TOPICS } from './topics.js';

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether some topic body names the label in bold, as the guide writes each permission and scope. */
const namedInBold = (label: string): boolean =>
  GUIDE_TOPICS.some((topic) => topic.body.includes(`**${label}**`));

describe('GUIDE_TOPICS', () => {
  it('gives every topic a unique kebab-case id', () => {
    const ids = GUIDE_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(KEBAB_CASE);
  });

  it('gives every topic a group, a title, a summary and a body', () => {
    for (const topic of GUIDE_TOPICS) {
      expect(topic.group.trim().length, topic.id).toBeGreaterThan(0);
      expect(topic.title.trim().length, topic.id).toBeGreaterThan(0);
      expect(topic.summary.trim().length, topic.id).toBeGreaterThan(0);
      expect(topic.body.trim().length, topic.id).toBeGreaterThan(0);
    }
  });

  it('keeps each summary within 140 characters and each body within 1500', () => {
    for (const topic of GUIDE_TOPICS) {
      expect(topic.summary.length, topic.id).toBeLessThanOrEqual(140);
      expect(topic.body.length, topic.id).toBeLessThanOrEqual(1500);
    }
  });

  it('uses only the light Markdown the dashboard renders', () => {
    for (const topic of GUIDE_TOPICS) {
      for (const line of topic.body.split('\n')) {
        expect(line, topic.id).not.toMatch(/^(#|>|\d+\. |\* )/);
      }
      expect(topic.body, topic.id).not.toMatch(/(^|[^*])\*[^*\n]+\*([^*]|$)/);
    }
  });

  it('names no web address in any body or summary', () => {
    for (const topic of GUIDE_TOPICS) {
      expect(topic.body, topic.id).not.toMatch(/https?:\/\//);
      expect(topic.summary, topic.id).not.toMatch(/https?:\/\//);
    }
  });

  it('links only to dashboard paths', () => {
    for (const topic of GUIDE_TOPICS) {
      for (const link of topic.seeAlso ?? []) {
        expect(link.path, topic.id).toMatch(/^\/[a-z0-9/-]*$/);
        expect(link.label.trim().length, topic.id).toBeGreaterThan(0);
      }
    }
  });

  it('names every capability label in bold in some topic body', () => {
    for (const info of Object.values(CAPABILITY_INFO)) {
      expect(namedInBold(info.label), info.label).toBe(true);
    }
  });

  it('names every MCP scope label in bold in some topic body', () => {
    for (const info of Object.values(MCP_SCOPE_INFO)) {
      expect(namedInBold(info.label), info.label).toBe(true);
    }
  });
});

describe('findGuideTopic', () => {
  it('finds a topic by its id', () => {
    const topic = GUIDE_TOPICS[0]!;
    expect(findGuideTopic(topic.id)).toBe(topic);
  });

  it('finds a topic by its title, ignoring case and surrounding spaces', () => {
    expect(findGuideTopic('  CONNECTING CLAUDE ')?.id).toBe('connecting-claude');
    expect(findGuideTopic('connecting claude')?.title).toBe('Connecting Claude');
  });

  it('finds a topic by its id, ignoring case', () => {
    expect(findGuideTopic('  Connecting-Claude ')?.title).toBe('Connecting Claude');
  });

  it('returns undefined for an unknown or empty query', () => {
    expect(findGuideTopic('no-such-topic')).toBeUndefined();
    expect(findGuideTopic('   ')).toBeUndefined();
  });
});

// ADR 0140: pin the copy shared by the dashboard and connected-app guide.
describe('Tasks through a connection copy', () => {
  it('says progress records are posted as update cards when task posts are on', () => {
    const body = findGuideTopic('claude-tools-tasks')!.body;
    expect(body.split('\n')).toContain(
      '- `task_progress`: record a progress report on an open task, posted to the task channel as an update card when task posts are on, or delete a report by hand.',
    );
    expect(body).not.toContain('without posting it');
  });

  it('names the five-link limit and both task link editing tools', () => {
    expect(findGuideTopic('claude-tools-tasks')!.body.split('\n')).toContain(
      'Tasks can carry up to 5 links (`links` on `create_task` / `update_task edit`).',
    );
  });
});
