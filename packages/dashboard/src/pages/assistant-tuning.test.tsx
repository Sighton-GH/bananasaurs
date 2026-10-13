import userEvent from '@testing-library/user-event';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { TUNING_URL, tuningKeyUrl, type TuningGroup } from '../api/tuning.js';
import { renderWithSession, stubFetch, bodyOf } from '../test-support.js';
import { AssistantTuningPage } from './assistant-tuning.js';

const SETTINGS = [
  {
    key: 'assistant.retryDelaysMs',
    group: 'Assistant retries',
    label: 'Retry delays',
    help: 'How long to wait before retrying when every AI model was busy or timed out.',
    display: 'seconds-list',
    bounds: { min: 1000, max: 180000, maxItems: 4 },
    value: [10000, 30000, 90000],
    defaultValue: [10000, 30000, 90000],
    isDefault: true,
  },
  {
    key: 'assistant.providerTimeoutMs',
    group: 'Assistant retries',
    label: 'Provider request timeout',
    help: 'How long one request to an AI provider may take before it is abandoned.',
    display: 'seconds',
    bounds: { min: 5000, max: 120000 },
    value: 60000,
    defaultValue: 60000,
    isDefault: false,
  },
  {
    key: 'assistant.providerIdleTimeoutMs',
    group: 'Assistant retries',
    label: 'Provider idle timeout',
    help: 'How long one AI answer may go without any data before it is abandoned. Keepalive messages count as data.',
    display: 'seconds',
    bounds: { min: 5000, max: 120000 },
    value: 45000,
    defaultValue: 45000,
    isDefault: true,
  },
  {
    key: 'assistant.providerMaxCallMs',
    group: 'Assistant retries',
    label: 'Provider max call time',
    help: 'The longest one AI answer may take in total, even when data keeps arriving.',
    display: 'seconds',
    bounds: { min: 60000, max: 600000 },
    value: 300000,
    defaultValue: 300000,
    isDefault: true,
  },
  {
    key: 'assistant.maxToolRounds',
    group: 'Assistant tool loop',
    label: 'Max tool rounds',
    help: 'How many rounds of tool use one question may take.',
    display: 'count',
    bounds: { min: 1, max: 8 },
    value: 4,
    defaultValue: 4,
    isDefault: true,
  },
  {
    key: 'assistant.channelContextMessages',
    group: 'Assistant context',
    label: 'Channel messages sent with each question',
    help: 'Recent messages from the channel the bot was tagged in, sent to the AI as background. 0 turns this off.',
    display: 'count',
    bounds: { min: 0, max: 50 },
    value: 15,
    defaultValue: 15,
    isDefault: true,
  },
  {
    key: 'network.connectFallbackMs',
    group: 'Network',
    label: 'Connect fallback wait (IPv4/IPv6)',
    help: 'How long to try one address family before falling back to the other.',
    display: 'milliseconds',
    bounds: { min: 100, max: 5000 },
    value: 1000,
    defaultValue: 1000,
    isDefault: true,
  },
  {
    key: 'resources.refreshIntervalMin',
    group: 'Resources',
    label: 'Refresh interval',
    help: 'How often cached resources are refreshed.',
    display: 'minutes',
    bounds: { min: 15, max: 1440 },
    value: 60,
    defaultValue: 60,
    isDefault: true,
  },
  {
    key: 'resources.fetchHeaderName',
    group: 'Resources',
    label: 'Fetch header name',
    help: 'An optional header sent with website fetches.',
    display: 'text',
    value: null,
    defaultValue: null,
    isDefault: true,
  },
  {
    key: 'resources.fetchHeaderValue',
    group: 'Resources',
    label: 'Fetch header value',
    help: "The header's secret value. Stored encrypted; never shown again.",
    display: 'secret',
    value: { configured: true },
    defaultValue: { configured: false },
    isDefault: false,
  },
  {
    key: 'resources.fetchHeaderHosts',
    group: 'Resources',
    label: 'Send the header only to',
    help: 'The header is sent only to these hosts, and never anywhere else.',
    display: 'host-list',
    bounds: { maxItems: 10 },
    value: [],
    defaultValue: [],
    isDefault: true,
  },
  {
    key: 'assistant.pingMaxMembers',
    group: 'Assistant replies',
    label: 'Reply pings: max members',
    help: 'How many members one assistant reply may ping. Only people the asker mentioned or named ever ping.',
    display: 'count',
    bounds: { min: 1, max: 5 },
    value: 5,
    defaultValue: 5,
    isDefault: true,
  },
  {
    key: 'assistant.pingMaxRoles',
    group: 'Assistant replies',
    label: 'Reply pings: max roles',
    help: 'How many roles one assistant reply may ping. Roles still pass the server ping rules.',
    display: 'count',
    bounds: { min: 1, max: 3 },
    value: 3,
    defaultValue: 3,
    isDefault: true,
  },
  {
    key: 'assistant.attachments.textMaxBytes',
    group: 'Assistant attachments',
    label: 'Text attachment size limit',
    help: 'The largest text file read from a message, in bytes. Larger files are skipped with a note.',
    display: 'count',
    bounds: { min: 1024, max: 1048576 },
    value: 262144,
    defaultValue: 262144,
    isDefault: true,
  },
  {
    key: 'assistant.attachments.textMaxChars',
    group: 'Assistant attachments',
    label: 'Text attachment characters sent',
    help: 'How many characters of each text file are sent to the AI. Longer files are cut with a note.',
    display: 'count',
    bounds: { min: 1000, max: 100000 },
    value: 24000,
    defaultValue: 24000,
    isDefault: true,
  },
  {
    key: 'assistant.attachments.textMaxCount',
    group: 'Assistant attachments',
    label: 'Text files read per message',
    help: 'How many text files are read from one message. 0 turns text attachments off.',
    display: 'count',
    bounds: { min: 0, max: 10 },
    value: 3,
    defaultValue: 3,
    isDefault: true,
  },
  {
    key: 'assistant.attachments.imageMaxBytes',
    group: 'Assistant attachments',
    label: 'Image size limit',
    help: 'The largest image sent to the AI, in bytes. Larger images are skipped with a note.',
    display: 'count',
    bounds: { min: 1024, max: 20971520 },
    value: 5242880,
    defaultValue: 5242880,
    isDefault: true,
  },
  {
    key: 'assistant.attachments.imageMaxCount',
    group: 'Assistant attachments',
    label: 'Images read per message',
    help: 'How many images are sent to the AI from one message. 0 turns image attachments off.',
    display: 'count',
    bounds: { min: 0, max: 10 },
    value: 4,
    defaultValue: 4,
    isDefault: true,
  },
  {
    key: 'assistant.attachments.pdfMaxBytes',
    group: 'Assistant attachments',
    label: 'PDF size limit',
    help: 'The largest PDF sent to the AI, in bytes. Larger PDFs are skipped with a note.',
    display: 'count',
    bounds: { min: 1024, max: 31457280 },
    value: 10485760,
    defaultValue: 10485760,
    isDefault: true,
  },
  {
    key: 'assistant.attachments.pdfMaxCount',
    group: 'Assistant attachments',
    label: 'PDFs read per message',
    help: 'How many PDFs are sent to the AI from one message. 0 turns PDF attachments off.',
    display: 'count',
    bounds: { min: 0, max: 10 },
    value: 2,
    defaultValue: 2,
    isDefault: true,
  },
];

const rowOf = (key: string) => screen.getByTestId(`tuning-row-${key}`);

const renderPage = () => renderWithSession(<AssistantTuningPage />);

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AssistantTuningPage', () => {
  it('accepts Assistant attachments as a tuning group', () => {
    expectTypeOf<'Assistant attachments'>().toExtend<TuningGroup>();
  });

  it('renders the five group headings and every label', async () => {
    stubFetch([{ url: TUNING_URL, body: { settings: SETTINGS } }]);
    renderPage();
    for (const group of [
      'Assistant retries',
      'Assistant tool loop',
      'Assistant context',
      'Assistant replies',
      'Assistant attachments',
      'Network',
      'Resources',
    ]) {
      expect(await screen.findByRole('heading', { name: group })).toBeTruthy();
    }
    for (const setting of SETTINGS) {
      expect(screen.getByLabelText(setting.label)).toBeTruthy();
    }
  });

  it('renders the attachment caps under Assistant attachments and saves one', async () => {
    const updated = {
      ...SETTINGS.find((s) => s.key === 'assistant.attachments.imageMaxCount')!,
      value: 2,
    };
    const mock = stubFetch([
      { url: TUNING_URL, body: { settings: SETTINGS } },
      {
        method: 'PUT',
        url: tuningKeyUrl('assistant.attachments.imageMaxCount'),
        body: { setting: updated },
      },
    ]);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Assistant attachments' })).toBeTruthy();
    const input = await screen.findByLabelText('Images read per message');
    expect(input).toHaveProperty('value', '4');
    fireEvent.change(input, { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(
        within(rowOf('assistant.attachments.imageMaxCount')).getByRole('button', { name: 'Save' }),
      );
    });
    const put = mock.mock.calls.find((c) => (c[0] as string).includes('/api/assistant/tuning/'));
    expect(put?.[1]).toMatchObject({ method: 'PUT' });
    expect(bodyOf(put!)).toEqual({ value: 2 });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('saves a ping cap as a plain count', async () => {
    const updated = { ...SETTINGS.find((s) => s.key === 'assistant.pingMaxMembers')!, value: 4 };
    const mock = stubFetch([
      { url: TUNING_URL, body: { settings: SETTINGS } },
      { method: 'PUT', url: tuningKeyUrl('assistant.pingMaxMembers'), body: { setting: updated } },
    ]);
    renderPage();
    const input = await screen.findByLabelText('Reply pings: max members');
    expect(input).toHaveProperty('value', '5');
    fireEvent.change(input, { target: { value: '4' } });
    await act(async () => {
      fireEvent.click(
        within(rowOf('assistant.pingMaxMembers')).getByRole('button', { name: 'Save' }),
      );
    });
    const put = mock.mock.calls.find((c) => (c[0] as string).includes('/api/assistant/tuning/'));
    expect(put?.[1]).toMatchObject({ method: 'PUT' });
    expect(bodyOf(put!)).toEqual({ value: 4 });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('saving the provider timeout converts seconds to milliseconds', async () => {
    const updated = {
      ...SETTINGS[1],
      value: 45000,
    };
    const mock = stubFetch([
      { url: TUNING_URL, body: { settings: SETTINGS } },
      {
        method: 'PUT',
        url: tuningKeyUrl('assistant.providerTimeoutMs'),
        body: { setting: updated },
      },
    ]);
    renderPage();
    const input = await screen.findByLabelText('Provider request timeout');
    expect(input).toHaveProperty('value', '60');
    fireEvent.change(input, { target: { value: '45' } });
    await act(async () => {
      fireEvent.click(
        within(rowOf('assistant.providerTimeoutMs')).getByRole('button', { name: 'Save' }),
      );
    });
    const put = mock.mock.calls.find((c) => (c[0] as string).includes('/api/assistant/tuning/'));
    expect(put?.[1]).toMatchObject({ method: 'PUT' });
    expect(bodyOf(put!)).toEqual({ value: 45000 });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('a refused retry-delay edit shows the server message under that row', async () => {
    stubFetch([
      { url: TUNING_URL, body: { settings: SETTINGS } },
      {
        method: 'PUT',
        url: tuningKeyUrl('assistant.retryDelaysMs'),
        status: 400,
        body: {
          error: 'invalid-setting',
          title: 'That value is not allowed',
          message: 'Retry delays must add up to 3 minutes or less.',
          fields: [{ path: '', problem: 'custom' }],
          requestId: 'req-0a1b2c3d',
        },
      },
    ]);
    renderPage();
    const input = await screen.findByLabelText('Retry delays');
    fireEvent.change(input, { target: { value: '60, 60, 61' } });
    await act(async () => {
      fireEvent.click(
        within(rowOf('assistant.retryDelaysMs')).getByRole('button', { name: 'Save' }),
      );
    });
    const row = rowOf('assistant.retryDelaysMs');
    expect(
      await within(row).findByText('Retry delays must add up to 3 minutes or less.'),
    ).toBeTruthy();
  });

  it('never shows or pre-fills the secret value', async () => {
    stubFetch([{ url: TUNING_URL, body: { settings: SETTINGS } }]);
    renderPage();
    const secret = await screen.findByLabelText('Fetch header value');
    expect(secret.getAttribute('type')).toBe('password');
    expect(secret).toHaveProperty('value', '');
    // No secret input anywhere on the page may carry a pre-filled value.
    const passwords = document.querySelectorAll('input[type="password"]');
    expect(passwords.length).toBeGreaterThan(0);
    for (const input of passwords) {
      expect((input as HTMLInputElement).value).toBe('');
    }
  });

  it('reset on a non-default row sends DELETE', async () => {
    const reset = { ...SETTINGS[1], value: 60000, isDefault: true };
    const mock = stubFetch([
      { url: TUNING_URL, body: { settings: SETTINGS } },
      {
        method: 'DELETE',
        url: tuningKeyUrl('assistant.providerTimeoutMs'),
        body: { setting: reset },
      },
    ]);
    renderPage();
    await screen.findByLabelText('Provider request timeout');
    await act(async () => {
      fireEvent.click(
        within(rowOf('assistant.providerTimeoutMs')).getByRole('button', { name: 'Reset' }),
      );
    });
    const del = mock.mock.calls.find((c) => (c[0] as string).includes('/api/assistant/tuning/'));
    expect(del?.[1]).toMatchObject({ method: 'DELETE' });
    expect(await screen.findByText('Reset to default')).toBeTruthy();
  });

  it('a non-owner load refusal renders the owner-only title', async () => {
    stubFetch([
      {
        url: TUNING_URL,
        status: 403,
        body: {
          error: 'owner-only',
          title: 'Only the owner can do that',
          message: "This setting belongs to the bot's owner account.",
        },
      },
    ]);
    renderPage();
    expect(await screen.findByText('Only the owner can do that')).toBeTruthy();
  });
});

it('keeps tuning drafts when query-backed sections change without saving', async () => {
  const mock = stubFetch([{ url: TUNING_URL, body: { settings: SETTINGS } }]);
  renderPage();
  const control = await screen.findByLabelText('Provider request timeout');
  fireEvent.change(control, { target: { value: '75' } });
  screen.getByRole('tab', { name: 'All settings' }).focus();
  await userEvent.keyboard('{ArrowRight}{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Resources' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('spinbutton', { name: 'Provider request timeout' })).toBeNull();
  await userEvent.keyboard('{ArrowLeft}');
  expect(screen.getByLabelText<HTMLInputElement>('Provider request timeout').value).toBe('75');
  expect(mock.mock.calls.some((call) => (call[1] as RequestInit)?.method === 'PUT')).toBe(false);
});
