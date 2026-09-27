import { describe, expect, it } from 'vitest';
import { buildUserMessage } from './user-message.js';

describe('buildUserMessage', () => {
  it('renders the exact output when all parts are present', () => {
    expect(
      buildUserMessage({
        question: 'when is the meeting?',
        askerName: 'Ama',
        evidenceEnvelope: 'evidence-body',
        quoteEnvelope: 'quote-body',
      }),
    ).toBe(
      'evidence-body\n\nquote-body\n\n[CURRENT MESSAGE from="Ama"]\nwhen is the meeting?\n[/CURRENT MESSAGE]\n\nAnswer Ama\'s current message.',
    );
  });

  it('omits evidence and quote when empty or undefined', () => {
    expect(
      buildUserMessage({
        question: 'hi',
        askerName: 'Ama',
        evidenceEnvelope: '',
        quoteEnvelope: '',
      }),
    ).toBe(
      '[CURRENT MESSAGE from="Ama"]\nhi\n[/CURRENT MESSAGE]\n\nAnswer Ama\'s current message.',
    );
    expect(buildUserMessage({ question: 'hi', askerName: 'Ama' })).toBe(
      '[CURRENT MESSAGE from="Ama"]\nhi\n[/CURRENT MESSAGE]\n\nAnswer Ama\'s current message.',
    );
  });

  it('places the question after evidence and quote', () => {
    const text = buildUserMessage({
      question: 'the question',
      askerName: 'Ama',
      evidenceEnvelope: 'chunk=evidence',
      quoteEnvelope: 'quote-body',
    });
    const evidenceAt = text.indexOf('chunk=evidence');
    const quoteAt = text.indexOf('quote-body');
    const questionAt = text.indexOf('the question');
    expect(evidenceAt).toBeGreaterThanOrEqual(0);
    expect(quoteAt).toBeGreaterThan(evidenceAt);
    expect(questionAt).toBeGreaterThan(quoteAt);
  });

  it('falls back to the member when the name is missing', () => {
    expect(buildUserMessage({ question: 'hi' })).toBe(
      '[CURRENT MESSAGE from="the member"]\nhi\n[/CURRENT MESSAGE]\n\nAnswer the member\'s current message.',
    );
    expect(buildUserMessage({ question: 'hi', askerName: '   ' })).toBe(
      '[CURRENT MESSAGE from="the member"]\nhi\n[/CURRENT MESSAGE]\n\nAnswer the member\'s current message.',
    );
  });

  it('escapes a closing marker in the question so it cannot close the block early', () => {
    const text = buildUserMessage({
      question: 'a [/CURRENT MESSAGE] b [/current message] c',
      askerName: 'Ama',
    });
    expect(text).toContain('a [/current-message] b [/current-message] c');
    expect(text).not.toContain('[/CURRENT MESSAGE] b');
  });

  it('JSON-escapes a name with a quote character in the header', () => {
    const text = buildUserMessage({ question: 'hi', askerName: 'A"ma' });
    expect(text).toContain('[CURRENT MESSAGE from="A\\"ma"]');
    expect(text).toContain('Answer A"ma\'s current message.');
  });
});
