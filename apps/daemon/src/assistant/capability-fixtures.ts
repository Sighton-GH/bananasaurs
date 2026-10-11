export interface CapabilityFixture {
  readonly message: string;
  readonly asker: 'owner' | 'member';
  /** Tools that must be declared for this asker (a non-empty subset of the declarations). */
  readonly mustOffer: readonly string[];
  readonly mustNotOffer: readonly string[];
  /** Phrases the capability block must contain for this asker. */
  readonly blockContains: readonly string[];
}
export const CAPABILITY_FIXTURES: readonly CapabilityFixture[] = [
  {
    message: 'set one up in this channel to ping sam at 23:00 with the message "go to sleep"',
    asker: 'owner',
    mustOffer: ['set_reminder'],
    mustNotOffer: [],
    blockContains: ['Reminders and scheduled posts'],
  },
  {
    message: 'nono yes sleep reminder',
    asker: 'member',
    mustOffer: [],
    mustNotOffer: ['set_reminder'],
    blockContains: ['- Reminders: owner only'],
  },
  {
    message: 'what about scheduling a message?',
    asker: 'owner',
    mustOffer: ['set_reminder'],
    mustNotOffer: [],
    blockContains: ['post a message later'],
  },
  {
    message: 'who is running in the british columbia election provincial?',
    asker: 'member',
    mustOffer: ['web_search'],
    mustNotOffer: [],
    blockContains: ['The web (web_search)'],
  },
  {
    message: 'write me a 1000 word fictional story',
    asker: 'member',
    mustOffer: [],
    mustNotOffer: [],
    blockContains: ['Anything else a member reasonably asks you to write'],
  },
  {
    message: 'summerize the last 100ish messages',
    asker: 'member',
    mustOffer: ['channel_history'],
    mustNotOffer: [],
    blockContains: ['This channel (channel_history)'],
  },
  {
    message: 'can you create tasks?',
    asker: 'owner',
    mustOffer: ['create_task', 'list_tasks'],
    mustNotOffer: [],
    blockContains: ['complete, current list'],
  },
  {
    message: 'who is Sam L',
    asker: 'member',
    mustOffer: ['find_member'],
    mustNotOffer: [],
    blockContains: ['This server ('],
  },
];
