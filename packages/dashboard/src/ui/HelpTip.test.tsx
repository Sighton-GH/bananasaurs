// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelpTip } from './HelpTip.js';

afterEach(cleanup);

const NAME = 'Help: message type';

function renderTip() {
  return render(
    <HelpTip label="message type">
      Normal hands the role out when a member reacts, and takes it back when they unreact.
    </HelpTip>,
  );
}

describe('HelpTip', () => {
  it('renders as a closed button named from its label', () => {
    renderTip();
    const trigger = screen.getByRole('button', { name: NAME });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('toggles on click and wires the note to the trigger', () => {
    renderTip();
    const trigger = screen.getByRole('button', { name: NAME });
    fireEvent.click(trigger);
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('hands the role out');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(note.id);
    fireEvent.click(trigger);
    expect(screen.queryByRole('note')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderTip();
    const trigger = screen.getByRole('button', { name: NAME });
    fireEvent.click(trigger);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a pointer down outside, but not on one inside the note', () => {
    renderTip();
    fireEvent.click(screen.getByRole('button', { name: NAME }));
    fireEvent.pointerDown(screen.getByRole('note'));
    expect(screen.getByRole('note')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shifts the note back inside the viewport when the trigger sits near the right edge', () => {
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    // The wrapper sits at x=300; the trigger is 16px wide and the note 240px,
    // so the note's natural span is 188..428 and must come in by 46px.
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const rect = { top: 0, bottom: 10, y: 0, height: 10, toJSON: () => ({}) };
        if (this.getAttribute('role') === 'note') {
          return { ...rect, left: 0, right: 240, x: 0, width: 240 };
        }
        return { ...rect, left: 300, right: 316, x: 300, width: 16 };
      });
    const widths = Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('role') === 'note' ? 240 : 16;
      },
    });
    try {
      renderTip();
      fireEvent.click(screen.getByRole('button', { name: NAME }));
      // 390 - 8 (viewport margin) - 428 (natural right edge) = -46.
      expect(screen.getByRole('note').style.transform).toContain('-46px');
    } finally {
      measure.mockRestore();
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widths);
      if (innerWidth !== undefined) {
        Object.defineProperty(window, 'innerWidth', innerWidth);
      }
    }
  });
});
