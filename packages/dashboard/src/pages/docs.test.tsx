// @vitest-environment jsdom
import { GUIDE_TOPICS } from '@bananasaurs/core';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Router } from 'wouter';
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
