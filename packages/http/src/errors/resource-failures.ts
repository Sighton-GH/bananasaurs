/**
 * The resource-fetch failure catalog: every `ResourceFetchFailureCode` the
 * website fetcher can report maps to a title, a plain explanation and a hint
 * naming the page or the action. The freshness route folds these into each
 * failed row as `errorExplain`, so the Resources page renders instead of
 * translating.
 *
 * Copy is plain Canadian English. Codes are kebab-case slugs and are never
 * renamed — the dashboard branches on them.
 */
/**
 * Shared with the error catalog: the same code is both a save refusal
 * (`PUT /api/assistant/resources/:id`) and a refresh failure (ADR 0082).
 */
export const GITHUB_URL_NEEDS_IMPORT_TEXT = {
  title: 'Use "Add from GitHub" for GitHub links',
  explanation:
    "A github.com page is GitHub's own website. Saved as a website, Bananasaurs would read GitHub's menus instead of your files.",
  hint: 'Add it with "Add from GitHub" on this page. For a single file, use its raw.githubusercontent.com link.',
} as const;

export const RESOURCE_FAILURE_TEXT: Readonly<
  Record<string, { title: string; explanation: string; hint: string }>
> = {
  challenge: {
    title: "The site's bot protection blocked Bananasaurs",
    explanation:
      'The site answered with a Cloudflare challenge page ("Just a moment…"), which only a browser can pass.',
    hint: "On Cloudflare's Free plan, Bot Fight Mode blocks Bananasaurs and no rule can skip it: turn Bot Fight Mode off, or add an IP Access rule that allows this server's IP. On Pro or higher, add a WAF custom rule that skips Super Bot Fight Mode when the header set in AI tuning → Resources is present. Or import the content from GitHub instead.",
  },
  'github-url-needs-import': GITHUB_URL_NEEDS_IMPORT_TEXT,
  'http-status': {
    title: 'The site answered with an error',
    explanation: 'The site returned an HTTP error instead of the page.',
    hint: 'Check the URL in a browser.',
  },
  timeout: {
    title: 'The site did not answer in time',
    explanation: 'The fetch took longer than the resource fetch timeout.',
    hint: 'Raise AI tuning → Resources → Fetch timeout, or try again later.',
  },
  'dns-failed': {
    title: "The site's address could not be looked up",
    explanation: 'DNS returned no address for this host.',
    hint: "Check the URL's spelling.",
  },
  network: {
    title: 'The site could not be reached',
    explanation: 'The connection failed before the page arrived.',
    hint: "Check the host's network, and try again.",
  },
  'private-address': {
    title: 'That address is not allowed',
    explanation: 'The host resolves to a private network address, which Bananasaurs never fetches.',
    hint: "Use the site's public address.",
  },
  redirect: {
    title: 'The site redirected somewhere not allowed',
    explanation: 'The page redirected too many times, or to a place Bananasaurs does not fetch.',
    hint: 'Use the final URL directly.',
  },
  'content-type': {
    title: 'The page is not text',
    explanation: 'The site returned a file type Bananasaurs does not read.',
    hint: 'Link to an HTML, Markdown or plain-text page.',
  },
  'too-large': {
    title: 'The page is too large',
    explanation: 'The page is bigger than the fetch size limit.',
    hint: 'Link to a smaller page or section.',
  },
  'invalid-url': {
    title: 'The URL is not allowed',
    explanation: 'Only public HTTPS URLs can be resources.',
    hint: 'Use an https:// address.',
  },
};
