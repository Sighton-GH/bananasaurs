// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const { render } = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render }) }));
vi.mock('./App.js', () => ({ default: () => null }));

// Import the real entrypoint: mocks isolate React's mount, not theme startup.
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  render.mockReset();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

it('boots light before rendering when acquiring localStorage throws', async () => {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  document.documentElement.setAttribute('data-theme', 'dark');
  const deniedStorage = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('denied');
  });
  render.mockImplementation(() => {
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  await expect(import('./main.js')).resolves.toBeDefined();

  expect(deniedStorage).toHaveBeenCalled();
  expect(render).toHaveBeenCalledOnce();
  expect(document.documentElement.dataset['theme']).toBe('light');
});
