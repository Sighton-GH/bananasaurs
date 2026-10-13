// @vitest-environment jsdom
import { GUIDE_TOPICS } from '@bananasaurs/core';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { GROUPS, NAV } from '../app/routes.js';
import { DocsPage } from './docs.js';

afterEach(cleanup);

const renderDocs = () =>
  render(
    <Router>
      <DocsPage />
    </Router>,
  );

const sectionFor = (id: string): HTMLElement => {
  const section = document.getElementById(id);
  if (section === null) throw new Error(`no section for ${id}`);
  return section;
};

describe('docs guide page', () => {
  it('shows one section per guide topic, with its title and summary', () => {
    renderDocs();
    for (const topic of GUIDE_TOPICS) {
      const section = sectionFor(topic.id);
      expect(within(section).getByRole('heading', { name: topic.title })).toBeTruthy();
      expect(section.textContent).toContain(topic.summary);
    }
  });

  it('shows each group heading once, in the order its topics first appear', () => {
    renderDocs();
    const groups = [...new Set(GUIDE_TOPICS.map((topic) => topic.group))];
    const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toEqual(groups);
  });

  it('nav links anchor to every topic section, in order', () => {
    renderDocs();
    const nav = screen.getByRole('navigation', { name: 'Guide sections' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(GUIDE_TOPICS.map((topic) => `#${topic.id}`));
  });

  it('no longer says the dashboard is owner-only, or that the operator turns task posts on', () => {
    renderDocs();
    expect(document.body.textContent).not.toMatch(/owner-only, always/);
    expect(document.body.textContent).not.toMatch(/owner-only by design/);
    expect(document.body.textContent).not.toMatch(/operator turns on task posts/);
  });

  it('renders the body as formatted text, with bullets and code', () => {
    renderDocs();
    const connecting = sectionFor('connecting-claude');
    const items = [...connecting.querySelectorAll('ul > li')].map((li) => li.textContent);
    expect(items[0]).toContain('Read');
    expect(connecting.querySelector('code')?.textContent).toBe('bananasaurs:read');
  });

  it('shows see-also links to their dashboard paths', () => {
    renderDocs();
    for (const topic of GUIDE_TOPICS) {
      const hrefs = within(sectionFor(topic.id))
        .queryAllByRole('link')
        .map((link) => link.getAttribute('href'));
      for (const link of topic.seeAlso ?? []) {
        expect(hrefs, topic.id).toContain(link.path);
      }
    }
  });

  it('keeps every link inside the dashboard', () => {
    renderDocs();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')?.startsWith('http')).toBe(false);
    }
  });
});

describe('guide page names (P4 Task 5)', () => {
  const navLabel = new Map(NAV.map((entry) => [entry.path, entry.label]));

  it("labels every see-also link to a rail page with that page's rail label", () => {
    for (const topic of GUIDE_TOPICS) {
      for (const link of topic.seeAlso ?? []) {
        const label = navLabel.get(link.path);
        if (label !== undefined) expect(link.label, `${topic.id} -> ${link.path}`).toBe(label);
      }
    }
  });

  it('describes the rail by its real groups, not the old sidebar groups', () => {
    const topic = GUIDE_TOPICS.find((entry) => entry.id === 'dashboard-pages');
    expect(topic?.body).toContain(
      `The rail groups its pages as ${GROUPS.slice(0, -1).join(', ')} and ${GROUPS[GROUPS.length - 1]}.`,
    );
    expect(topic?.body).not.toContain('Advanced / System');
    expect(topic?.summary).not.toContain('sidebar');
  });

  it('never calls the role panels page by its old name', () => {
    const text = GUIDE_TOPICS.map((topic) => `${topic.title} ${topic.summary} ${topic.body}`).join(
      '\n',
    );
    expect(text).not.toContain('Self-granted roles');
    expect(GUIDE_TOPICS.find((entry) => entry.id === 'role-panels')?.body).toContain(
      'the Role panels page',
    );
  });

  it('bolds the Review queue and Audit log page names in the topics that list pages', () => {
    const body = (id: string) => GUIDE_TOPICS.find((entry) => entry.id === id)?.body ?? '';
    expect(body('moderation')).toContain('**Review queue**');
    expect(body('moderation')).toContain('**Audit log**');
    expect(body('system-pages')).toContain('**Audit log**');
  });

  it('names the Audit log page in the system pages summary', () => {
    const summary = GUIDE_TOPICS.find((entry) => entry.id === 'system-pages')?.summary ?? '';
    expect(summary).toContain('Audit log');
    expect(summary).not.toContain('Audit page');
  });

  it('(7c) uses the token scale and kit links, and keeps the in-page anchors', () => {
    renderDocs();
    const root = document.body;
    expect(root.querySelector('.rounded-md, .text-xs, .text-sm, .text-base')).toBeNull();
    const seeAlso = screen.getAllByText('See also:')[0]!.parentElement!;
    expect(seeAlso.querySelector('a')?.className).toContain('text-accent');
    for (const topic of GUIDE_TOPICS)
      expect(
        screen
          .getByRole('navigation', { name: 'Guide sections' })
          .querySelector(`a[href="#${topic.id}"]`),
      ).toBeTruthy();
  });
});
