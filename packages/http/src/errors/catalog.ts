/**
 * The one error catalog (ADR 0078).
 *
 * Every kebab-case refusal code the dashboard API can send maps to a title,
 * a plain explanation and an optional hint. The `onSend` hook in `server.ts`
 * folds these into every JSON error body, so the dashboard renders instead
 * of translating — and a new route cannot ship an unexplained code without
 * failing `catalog.test.ts`.
 *
 * Copy is plain Canadian English: short sentences, no jargon in titles, a
 * hint that names the page or the action. Codes are never renamed — the
 * dashboard and the CLI branch on them.
 */
export interface ErrorExplanation {
  readonly title: string;
  readonly explanation: string;
  readonly hint?: string;
}

export const ERROR_CATALOG: Readonly<Record<string, ErrorExplanation>> = {
  internal: {
    title: 'Something went wrong inside Bananasaurs',
    explanation: 'Nothing was changed. The daemon log has the detail under this request id.',
    hint: 'Search the journal for the request id shown below.',
  },
  'bad-request': {
    title: 'The request was not valid',
    explanation: 'One or more fields were missing or had the wrong format.',
    hint: 'Fix the highlighted fields and try again.',
  },
  'owner-only': {
    title: 'Only the owner can do that',
    explanation: "This setting belongs to the bot's owner account.",
    hint: 'Sign in as the owner.',
  },
  'owner-protected': {
    title: "That can't be changed",
    explanation: "The owner account can't be changed.",
  },
  'weak-password': {
    title: 'That password is too short',
    explanation: 'Use at least 12 characters.',
  },
  'username-taken': {
    title: 'That username is taken',
    explanation: 'That username is already in use.',
    hint: 'Choose another.',
  },
  'not-revealable': {
    title: "That password can't be shown",
    explanation: "This password can't be shown. Set a new one instead.",
  },
  'read-only': {
    title: 'Bananasaurs is read-only',
    explanation:
      'This instance was started with BANANASAURS_READONLY, so nothing can be changed.',
    hint: 'Restart without BANANASAURS_READONLY to make changes.',
  },
  csrf: {
    title: 'Your page is out of date',
    explanation: "The page's security token did not match.",
    hint: 'Reload the page and try again.',
  },
  unauthenticated: {
    title: 'You are signed out',
    explanation: 'Your session ended.',
    hint: 'Sign in again.',
  },
  'reauth-required': {
    title: 'Confirm your password',
    explanation: 'This action needs your password again.',
  },
  'provider-secret-store-not-configured': {
    title: "Provider keys can't be stored",
    explanation:
      "The daemon has no provider secret, so keys and sealed settings can't be saved.",
    hint: 'Set ASSISTANT_PROVIDER_SECRET_KEY or let the daemon create its key file, then restart.',
  },
  'unknown-setting': {
    title: 'No such setting',
    explanation: 'That setting does not exist.',
    hint: 'Reload the page.',
  },
  'invalid-setting': {
    title: 'That value is not allowed',
    explanation: 'The value is outside what this setting accepts.',
    hint: 'Check the limits shown under the setting.',
  },
  'settings-unavailable': {
    title: 'AI tuning is not available',
    explanation: 'The settings store is not wired in this process.',
    hint: 'Restart the daemon. If it persists, check the daemon log.',
  },
  'unreadable-response': {
    title: "The server's answer could not be read",
    explanation:
      'Something between the browser and Bananasaurs answered with a page that is not JSON.',
    hint: 'Check that the daemon is running and the tunnel is up.',
  },
  'dashboard-offline': {
    title: 'Bananasaurs could not be reached',
    explanation: 'The browser could not reach the dashboard API. The daemon may be restarting.',
    hint: 'Wait a moment and try again.',
  },
  'not-found': {
    title: 'Not found',
    explanation: 'Nothing with that id exists.',
    hint: 'Reload the page and try again.',
  },
  'no-grant': {
    title: 'Missing permission',
    explanation: 'Your account does not hold the permission this action needs.',
    hint: 'Ask the owner to grant it.',
  },
  'no-such-account': {
    title: 'No such account',
    explanation: 'No account with that username exists.',
    hint: 'Check the spelling and try again.',
  },
  'wrong-kind': {
    title: 'Wrong kind of rule',
    explanation: 'That action does not apply to this kind of rule.',
    hint: 'Pick a rule of the right kind.',
  },
  'rate-limited': {
    title: 'Too many tries',
    explanation: 'This action is limited and the limit was reached.',
    hint: 'Wait a while and try again.',
  },
  'invalid-query': {
    title: 'The search was not valid',
    explanation: 'A filter or page marker had the wrong format.',
    hint: 'Reload the page and try again.',
  },
  'not-github': {
    title: 'Not a GitHub link',
    explanation: 'That address is not a GitHub repository or organisation page.',
    hint: 'Paste a github.com link.',
  },
  'invalid-transition': {
    title: "That can't be done now",
    explanation: 'That item is not in a state this action can change.',
    hint: 'Reload the page to see its current state.',
  },
  'guild-not-archive-enabled': {
    title: 'Archiving is off for this server',
    explanation: 'This server is not in the archive list.',
    hint: 'Add the server to the archive list first.',
  },
  'no-such-provider': {
    title: 'No such provider',
    explanation: 'That AI provider is not recorded here.',
    hint: 'Pick a provider from the list.',
  },
  'no-such-channel': {
    title: 'No such channel',
    explanation: 'That channel is not in this server.',
    hint: 'Pick the channel from the list.',
  },
  'no-guild-access': {
    title: 'No access to that server',
    explanation: 'Your account cannot reach that server.',
    hint: 'Ask the owner for access.',
  },
  'duplicate-entry': {
    title: 'That entry is already listed',
    explanation: 'The same key and model appear twice in the chain.',
    hint: 'Remove the duplicate and save again.',
  },
  'behaviour-disabled': {
    title: 'That behaviour is off',
    explanation: 'The behaviour this needs is disabled.',
    hint: 'Turn the behaviour on first.',
  },
  'behaviour-conflict': {
    title: 'Two behaviours would answer',
    explanation: 'Another behaviour already answers the same mention.',
    hint: 'Change one of the mentions.',
  },
  'unknown-key': {
    title: 'No such key',
    explanation: 'That key id is not saved here.',
    hint: 'Pick a key from the list.',
  },
  'too-many': {
    title: 'Too many entries',
    explanation: 'The model chain holds at most six entries.',
    hint: 'Remove one and try again.',
  },
  'provider-refused': {
    title: 'The provider refused the key',
    explanation: 'The AI provider would not accept that key or model.',
    hint: 'Check the key and the model name.',
  },
  'prompt-version-conflict': {
    title: 'Your page is out of date',
    explanation: 'Someone saved this behaviour while you were editing.',
    hint: 'Reload and merge your changes.',
  },
  'not-denied': {
    title: 'That is not denied',
    explanation: 'That domain is not on the deny list, so there is nothing to remove.',
    hint: 'Reload the page.',
  },
  'not-archived': {
    title: 'Not archived',
    explanation: 'That channel is not being archived.',
    hint: 'Turn archiving on for the channel first.',
  },
  'message-unusable': {
    title: "That message can't be used",
    explanation: 'The channel or message id did not match a real message.',
    hint: 'Check the ids and try again.',
  },
  'mention-role-required': {
    title: 'A mention role is needed',
    explanation: 'A behaviour outside direct commands must mention a role.',
    hint: 'Pick which role mentions it.',
  },
  'invalid-definition': {
    title: 'The panel is not valid',
    explanation: 'The role panel definition has a mistake.',
    hint: 'Fix the highlighted fields and try again.',
  },
  'invalid-config': {
    title: 'The rule is not valid',
    explanation: 'The rule settings have a mistake.',
    hint: 'Fix the highlighted fields and try again.',
  },
  'invalid-body': {
    title: 'The form was not valid',
    explanation: 'The submitted form had the wrong shape.',
    hint: 'Reload the page and try again.',
  },
  'invalid-credentials': {
    title: 'Wrong username or password',
    explanation: 'The username is unknown or the password is wrong.',
    hint: 'Check both and try again.',
  },
  'github-not-configured': {
    title: 'GitHub is not connected',
    explanation: "No GitHub token is saved, so GitHub can't be reached.",
    hint: 'Save a GitHub token on the AI providers page.',
  },
  exists: {
    title: 'Already exists',
    explanation: 'A rule with that id already exists.',
    hint: 'Pick another id or edit the existing rule.',
  },
  'already-exists': {
    title: 'Already exists',
    explanation: 'That panel id is already in use.',
    hint: 'Pick another id.',
  },
  'already-undone': {
    title: 'Already undone',
    explanation: 'That batch was already undone.',
    hint: 'Reload the page.',
  },
  unsupported: {
    title: "Models can't be listed",
    explanation: 'That provider does not offer a model list.',
    hint: 'Type the model name instead.',
  },
  'unsafe-resource-url': {
    title: 'That link is not allowed',
    explanation: 'Resource links must be safe http or https addresses.',
    hint: 'Paste another link.',
  },
  'not-eligible': {
    title: "The rule can't go live yet",
    explanation: "The rule did not pass its checks, so it can't be enabled.",
    hint: 'Read the refusal and fix what it names.',
  },
  'no-such-token': {
    title: 'No such token',
    explanation: 'That token id is not recorded here.',
    hint: 'Pick a token from the list.',
  },
  'no-such-client': {
    title: 'No such app',
    explanation: 'That client id is not registered here.',
    hint: 'Pick an app from the list.',
  },
  'memory-details-required': {
    title: 'More detail is needed',
    explanation: 'Saving that memory needs its section and content.',
    hint: 'Fill in the missing fields.',
  },
  'forum-requires-all': {
    title: 'Forum channels need every thread',
    explanation: 'A forum channel can only archive with all threads included.',
    hint: "Choose 'all' for forum channels.",
  },
  'bad-since': {
    title: 'That time filter is not valid',
    explanation: "The 'since' value is not a time this page understands.",
    hint: 'Clear the filter and try again.',
  },
  'backup-failed': {
    title: 'The backup failed',
    explanation: 'The backup did not finish, so nothing was stored.',
    hint: 'Check the daemon log and try again.',
  },
  'assistant-try-unavailable': {
    title: 'Trying is not available',
    explanation: 'The try-it box is not wired in this process.',
    hint: 'Restart the daemon.',
  },
  'unmanageable-role': {
    title: "That role can't be managed",
    explanation: "Discord places that role above the bot, so the bot can't grant it.",
    hint: "Move the bot's role higher in the server settings.",
  },
  'no-key': {
    title: 'No key saved',
    explanation: 'No key is saved for that lookup, so there is nothing to ask with.',
    hint: 'Save a key first.',
  },
  'locked-out': {
    title: 'Locked out for a while',
    explanation: 'Too many wrong passwords locked this account for a time.',
    hint: 'Wait and try again later.',
  },
  'guild-required': {
    title: 'Pick a server',
    explanation: 'That account reaches more than one server, so pick which to open.',
    hint: 'Choose a server to continue.',
  },
  'bad-token': {
    title: 'That setup link is not valid',
    explanation: 'The setup token is wrong or was already used.',
    hint: 'Ask for a new setup token and try again.',
  },
  'already-provisioned': {
    title: 'Already set up',
    explanation: 'The first account already exists, so setup is closed.',
    hint: 'Sign in instead.',
  },
  'no-guild': {
    title: 'No server found',
    explanation: 'Setup found no server to attach the first account to.',
    hint: 'Invite the bot to a server first.',
  },
  'not-failed': {
    title: 'That job did not fail',
    explanation: 'Only a failed job can be retried.',
    hint: 'Reload the page.',
  },
  'dedupe-blocked': {
    title: 'Already queued',
    explanation: 'The same job is already queued, so a retry would be a duplicate.',
    hint: 'Wait for the queued job.',
  },
  'not-observing': {
    title: 'Not ready yet',
    explanation: "That rule is still being observed and can't be marked ready.",
    hint: 'Wait for the observation window.',
  },
};

/** The catalog entry, or a generic one for a code no route explains yet. */
export const explainError = (code: string): ErrorExplanation =>
  ERROR_CATALOG[code] ?? {
    title: 'The request failed',
    explanation: `Bananasaurs refused the request (${code}).`,
  };
