// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Tabs, TabPanel } from './Tabs.js';
afterEach(cleanup);
it('names its tabs and automatically selects and labels the focused panel', async () => {
  const change = vi.fn();
  function Example() {
    const [value, setValue] = useState('one');
    return (
      <Tabs
        value={value}
        onValueChange={(v) => {
          change(v);
          setValue(v);
        }}
        aria-label="Sections"
        tabs={[
          { value: 'one', label: 'First', badge: <span>3</span> },
          { value: 'two', label: 'Second' },
        ]}
      >
        <TabPanel value="one">First content</TabPanel>
        <TabPanel value="two">Second content</TabPanel>
      </Tabs>
    );
  }
  render(<Example />);
  expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(1);
  expect(screen.getByRole('tab', { name: 'First 3' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('Second content')).toBeNull();
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Second' }));
  expect(change).toHaveBeenCalledWith('two');
  expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tabpanel', { name: 'Second' }).textContent).toBe('Second content');
  expect(screen.queryByText('First content')).toBeNull();
});

it('bounds the tab row, keeps whole ordinary labels and reserves room for focus outlines', () => {
  render(
    <Tabs
      value="one"
      onValueChange={() => undefined}
      aria-label="Sections"
      tabs={[
        { value: 'one', label: 'First section' },
        { value: 'two', label: 'Second section' },
      ]}
    >
      <TabPanel value="one">First content</TabPanel>
    </Tabs>,
  );
  const list = screen.getByRole('tablist');
  for (const token of ['max-w-full', 'overflow-x-auto', 'p-1'])
    expect(list.classList.contains(token)).toBe(true);
  for (const tab of screen.getAllByRole('tab')) {
    expect(tab.classList.contains('shrink-0')).toBe(true);
    expect(tab.classList.contains('max-w-full')).toBe(true);
    expect(tab.firstElementChild?.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
  }
});

it('keeps the focus outline inside each scrolled tab, without negative bottom margins', () => {
  render(
    <Tabs
      value="one"
      onValueChange={() => undefined}
      aria-label="Sections"
      tabs={[
        { value: 'one', label: 'First' },
        { value: 'two', label: 'Second' },
      ]}
    >
      <TabPanel value="one">Content</TabPanel>
    </Tabs>,
  );
  for (const tab of screen.getAllByRole('tab')) {
    expect(tab.classList.contains('focus-visible:outline-offset-[-2px]')).toBe(true);
    expect(tab.classList.contains('-mb-px')).toBe(false);
  }
});

it('keyboard can reach both row edges and keeps panels linked to the selected tab', async () => {
  function Example() {
    const [value, setValue] = useState('one');
    return (
      <Tabs
        value={value}
        onValueChange={setValue}
        aria-label="Edge sections"
        tabs={[
          { value: 'one', label: 'First' },
          { value: 'two', label: 'Second' },
          { value: 'three', label: 'Third' },
        ]}
      >
        <TabPanel value="one">First panel</TabPanel>
        <TabPanel value="two">Second panel</TabPanel>
        <TabPanel value="three">Third panel</TabPanel>
      </Tabs>
    );
  }
  render(<Example />);
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Third' }));
  expect(screen.getByRole('tabpanel', { name: 'Third' }).textContent).toBe('Third panel');
  await user.keyboard('{Home}');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'First' }));
  expect(screen.getByRole('tabpanel', { name: 'First' }).textContent).toBe('First panel');
});

function mockGeometry(
  list: HTMLElement,
  tabs: HTMLElement[],
  listLeft: number,
  listWidth: number,
  tabWidth: number,
): { scrollLeft: () => number } {
  // jsdom has no layout: model a clipped row where tab i sits at i*tabWidth - scroll.
  let scroll = 0;
  Object.defineProperty(list, 'scrollLeft', {
    configurable: true,
    get: () => scroll,
    set: (v: number) => {
      scroll = v;
    },
  });
  list.getBoundingClientRect = () => ({
    left: listLeft,
    right: listLeft + listWidth,
    width: listWidth,
    top: 0,
    bottom: 40,
    height: 40,
    x: listLeft,
    y: 0,
    toJSON: () => ({}),
  });
  tabs.forEach((tab, i) => {
    tab.getBoundingClientRect = () => {
      const left = listLeft + i * tabWidth - scroll;
      return {
        left,
        right: left + tabWidth,
        width: tabWidth,
        top: 0,
        bottom: 40,
        height: 40,
        x: left,
        y: 0,
        toJSON: () => ({}),
      };
    };
  });
  return { scrollLeft: () => scroll };
}

function NarrowExample() {
  const [value, setValue] = useState('one');
  return (
    <Tabs
      value={value}
      onValueChange={setValue}
      aria-label="Narrow"
      tabs={[
        { value: 'one', label: 'First' },
        { value: 'two', label: 'Second' },
        { value: 'three', label: 'Third' },
      ]}
    >
      <TabPanel value="one">One</TabPanel>
      <TabPanel value="two">Two</TabPanel>
      <TabPanel value="three">Three</TabPanel>
    </Tabs>
  );
}

it('scrolls only the tablist so a keyboard-focused clipped tab is fully visible (Home/End/Arrows)', async () => {
  const pageScroll = vi.fn();
  window.scrollTo = pageScroll;
  render(<NarrowExample />);
  const list = screen.getByRole('tablist');
  const tabs = screen.getAllByRole('tab');
  // 100px row, 70px tabs: Second (70..140) is clipped by 40px, Third (140..210) is outside.
  const geo = mockGeometry(list, tabs, 0, 100, 70);
  const user = userEvent.setup();
  await user.tab();
  expect(geo.scrollLeft()).toBe(0);
  await user.keyboard('{ArrowRight}');
  await vi.waitFor(() => expect(document.activeElement).toBe(tabs[1]));
  expect(geo.scrollLeft()).toBe(40);
  await user.keyboard('{End}');
  await vi.waitFor(() => expect(document.activeElement).toBe(tabs[2]));
  expect(geo.scrollLeft()).toBe(110);
  await user.keyboard('{ArrowLeft}');
  await vi.waitFor(() => expect(document.activeElement).toBe(tabs[1]));
  expect(geo.scrollLeft()).toBe(70);
  await user.keyboard('{Home}');
  await vi.waitFor(() => expect(document.activeElement).toBe(tabs[0]));
  expect(geo.scrollLeft()).toBe(0);
  expect(pageScroll).not.toHaveBeenCalled();
});

it('does not move the row when the keyboard-focused tab is already fully visible', async () => {
  render(<NarrowExample />);
  const list = screen.getByRole('tablist');
  const tabs = screen.getAllByRole('tab');
  const geo = mockGeometry(list, tabs, 0, 300, 70);
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{ArrowRight}');
  await vi.waitFor(() => expect(document.activeElement).toBe(tabs[1]));
  expect(geo.scrollLeft()).toBe(0);
});

it('leaves mouse selection alone and never calls element scrollIntoView', async () => {
  const intoView = vi.fn();
  Element.prototype.scrollIntoView = intoView;
  render(<NarrowExample />);
  const list = screen.getByRole('tablist');
  const tabs = screen.getAllByRole('tab');
  const geo = mockGeometry(list, tabs, 0, 100, 70);
  const user = userEvent.setup();
  const second = screen.getByRole('tab', { name: 'Second' });
  await user.click(second);
  expect(second.getAttribute('aria-selected')).toBe('true');
  expect(geo.scrollLeft()).toBe(0);
  expect(intoView).not.toHaveBeenCalled();
});

it('sets scrollLeft directly (instant), so reduced motion is respected', async () => {
  render(<NarrowExample />);
  const list = screen.getByRole('tablist');
  const tabs = screen.getAllByRole('tab');
  mockGeometry(list, tabs, 0, 100, 70);
  const scrollTo = vi.fn();
  list.scrollTo = scrollTo;
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{ArrowRight}');
  await vi.waitFor(() => expect(document.activeElement).toBe(tabs[1]));
  expect(scrollTo).not.toHaveBeenCalled();
  expect(list.scrollLeft).toBe(40);
});
