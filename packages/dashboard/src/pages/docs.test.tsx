// @vitest-environment jsdom
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

describe('docs guide page', () => {
  it('covers the task-tracking workflow end to end', () => {
    renderDocs();
    for (const name of [
      'Tasks',
      'Who sees what',
      'Creating a task',
      'Statuses',
      'Review and approval',
      'Keeping records',
      'Priorities',
      'Reminders',
      'Quiet hours',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
    const statuses = screen.getByRole('heading', { name: 'Statuses' }).closest('section')!;
    const chips = within(statuses)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(chips).toEqual(['Not started', 'In progress', 'Awaiting approval', 'Done']);
  });

  it('states the dashboard is owner-only and members work in Discord', () => {
    renderDocs();
    expect(screen.getByText("Their team's tasks, in Discord")).toBeTruthy();
    expect(screen.getByText("The exec team's tasks, in Discord")).toBeTruthy();
    expect(screen.getByText("Every team's board, here in the dashboard")).toBeTruthy();
    expect(screen.getByText(/The dashboard is owner-only, always/)).toBeTruthy();
    expect(screen.getByText(/owner-only by design/)).toBeTruthy();
    expect(
      screen.getAllByText(/go out only when the operator turns on task posts/).length,
    ).toBeGreaterThanOrEqual(2);
    // No promise of future member dashboard views or account-link verification.
    expect(screen.queryByText(/account linking/i)).toBeNull();
  });

  it('describes progress replies and review without a president-only owner', () => {
    renderDocs();
    expect(
      screen.getByText(/A reply with an update is saved; a reply like 'ok' is not/),
    ).toBeTruthy();
    expect(screen.getByText(/the bot posts a review request in the task's channel/)).toBeTruthy();
    expect(screen.queryByText(/\(president\)/)).toBeNull();
  });

  it('states task creation and record keeping exactly', () => {
    renderDocs();
    const creating = screen.getByRole('heading', { name: 'Creating a task' }).closest('section')!;
    expect(creating.textContent).toContain(
      'The owner uses New task here, or an MCP client the owner has connected.',
    );
    const keeping = screen.getByRole('heading', { name: 'Keeping records' }).closest('section')!;
    expect(keeping.textContent).toContain(
      'Approved tasks are archived automatically with all their updates. Nothing is deleted unless the owner deletes a task or a single update on its page.',
    );
  });

  it('covers the rest of the dashboard at the same concise standard', () => {
    renderDocs();
    for (const name of ['Moderation', 'Messages and archive', 'Assistant', 'Server', 'System']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
    // Every section stays scannable: no card may turn into an essay.
    for (const section of document.querySelectorAll('section')) {
      expect((section.textContent ?? '').length).toBeLessThan(600);
    }
  });

  it('nav chips anchor to real sections and links stay inside the dashboard', () => {
    renderDocs();
    const nav = screen.getByRole('navigation', { name: 'Guide sections' });
    const chips = within(nav).getAllByRole('link');
    expect(chips.length).toBeGreaterThanOrEqual(10);
    for (const chip of chips) {
      const href = chip.getAttribute('href')!;
      expect(href.startsWith('#')).toBe(true);
      expect(document.getElementById(href.slice(1))).toBeTruthy();
    }
    for (const link of screen.getAllByRole('link')) {
      const href = link.getAttribute('href')!;
      expect(href.startsWith('http')).toBe(false);
    }
  });
});
