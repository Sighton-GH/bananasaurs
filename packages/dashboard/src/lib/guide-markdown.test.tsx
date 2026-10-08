// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { renderGuideMarkdown } from './guide-markdown.js';

afterEach(cleanup);

const renderText = (text: string): HTMLElement => {
  const { container } = render(<Router>{renderGuideMarkdown(text)}</Router>);
  return container;
};

describe('renderGuideMarkdown', () => {
  it('renders blank-line separated paragraphs as separate paragraphs', () => {
    const container = renderText('First paragraph.\n\nSecond paragraph.');
    const paragraphs = [...container.querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('renders each "- " line as one list item', () => {
    const container = renderText('Intro:\n- first\n- second');
    expect(container.querySelector('p')?.textContent).toBe('Intro:');
    const items = [...container.querySelectorAll('ul > li')].map((li) => li.textContent);
    expect(items).toEqual(['first', 'second']);
  });

  it('keeps prose and bullets in one block as a paragraph, a list, then a paragraph', () => {
    const container = renderText('Before the list\n- first\n- second\nAfter the list');
    expect([...container.children].map((el) => el.tagName)).toEqual(['P', 'UL', 'P']);
    expect(container.children[2]?.textContent).toBe('After the list');
  });

  it('renders `code` as code, and leaves the backticks out', () => {
    const container = renderText('Run `bananasaurs status` now.');
    expect(container.querySelector('code')?.textContent).toBe('bananasaurs status');
    expect(container.textContent).toBe('Run bananasaurs status now.');
  });

  it('renders **bold** as strong text, and leaves the asterisks out', () => {
    const container = renderText('This is **important**.');
    expect(container.querySelector('strong')?.textContent).toBe('important');
    expect(container.textContent).toBe('This is important.');
  });

  it('renders an internal link as a link to that dashboard path', () => {
    const container = renderText('See [Tasks](/tasks) for more.');
    const link = container.querySelector('a');
    expect(link?.textContent).toBe('Tasks');
    expect(link?.getAttribute('href')).toBe('/tasks');
  });

  it('renders an absolute web link as its plain label, with no anchor', () => {
    const container = renderText('Read [the policy](https://example.com/policy) first.');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('Read the policy first.');
  });

  it('renders any other link target as its plain label', () => {
    const container = renderText('Click [here](javascript:alert(1)) or [there](//example.com).');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('Click here or there.');
  });

  it('shows unknown syntax literally', () => {
    const container = renderText('# Heading\n*emphasis* and ~~struck~~\n> quoted');
    expect(container.textContent).toBe('# Heading *emphasis* and ~~struck~~ > quoted');
    expect(container.querySelector('h1, em, del, blockquote')).toBeNull();
  });

  it('leaves an unmatched backtick or asterisk as typed', () => {
    const container = renderText('A lone ` and a lone ** here, with -not a bullet.');
    expect(container.textContent).toBe('A lone ` and a lone ** here, with -not a bullet.');
    expect(container.querySelector('code, strong, ul')).toBeNull();
  });

  it('never injects HTML: a script tag in the text shows as text', () => {
    const container = renderText('Hello <script>alert("x")</script> and <b>bold</b>.');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('Hello <script>alert("x")</script> and <b>bold</b>.');
  });

  it('renders empty text as nothing', () => {
    expect(renderText('').textContent).toBe('');
  });
});
