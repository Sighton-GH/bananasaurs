/**
 * The dashboard's side of the Conversations contract (Task 19). The list,
 * one transcript and the auto-delete retention each answer from their own
 * endpoint; end and delete write through `session.write`.
 */

/** Who started the conversation, when live Discord still knows the id; null renders the bare id. */
export interface ConversationMember {
  readonly username: string;
  readonly displayName: string;
}

export interface ConversationRow {
  readonly conversationId: string;
  readonly channelId: string;
  readonly behaviourId: string;
  readonly startedBy: string;
  readonly title: string;
  readonly source: 'discord' | 'dashboard-test';
  readonly status: 'open' | 'ended';
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly turnCount: number;
  /** Distinct names from the human sides, first-seen order. */
  readonly people: readonly string[];
  readonly member: ConversationMember | null;
}

export interface ConversationListResponse {
  readonly conversations: readonly ConversationRow[];
  readonly nextBefore?: number;
}

export interface ConversationTurnRow {
  readonly turnId: string;
  readonly at: number;
  readonly role: 'user' | 'assistant' | 'quote';
  readonly authorId?: string;
  readonly authorName: string;
  readonly text: string;
  readonly traceId?: string;
  readonly feedback?: 'up' | 'down';
  /** Title and URL only, for the assistant turn's sources line. */
  readonly sources?: readonly { readonly title: string; readonly url: string }[];
}

export interface ConversationDetailResponse {
  readonly conversation: Omit<ConversationRow, 'people' | 'member'>;
  readonly turns: readonly ConversationTurnRow[];
}

/** The auto-delete window in days; null keeps conversations forever. */
export type RetentionDays = 61 | 182 | 365 | null;

export interface RetentionResponse {
  readonly days: RetentionDays;
}

export const CONVERSATIONS_URL = '/api/assistant/conversations';
export const RETENTION_URL = '/api/assistant/conversation-retention';

export interface ConversationFilters {
  readonly channelId: string;
  readonly userId: string;
  readonly behaviourId: string;
  readonly search: string;
}

export const EMPTY_CONVERSATION_FILTERS: ConversationFilters = {
  channelId: '',
  userId: '',
  behaviourId: '',
  search: '',
};

/** The four orders the sort select offers, in the words the page shows. */
export type ConversationSort = 'activity-desc' | 'activity-asc' | 'started-desc' | 'turns-desc';

export const SORT_OPTIONS: readonly { readonly value: ConversationSort; readonly label: string }[] =
  [
    { value: 'activity-desc', label: 'Newest activity' },
    { value: 'activity-asc', label: 'Oldest activity' },
    { value: 'started-desc', label: 'Recently started' },
    { value: 'turns-desc', label: 'Most turns' },
  ];

const sortParams = (sort: ConversationSort): { readonly sort: string; readonly order: string } => {
  switch (sort) {
    case 'activity-asc':
      return { sort: 'last-activity', order: 'asc' };
    case 'started-desc':
      return { sort: 'started', order: 'desc' };
    case 'turns-desc':
      return { sort: 'turns', order: 'desc' };
    case 'activity-desc':
    default:
      return { sort: 'last-activity', order: 'desc' };
  }
};

export const conversationListUrl = (
  filters: ConversationFilters,
  sort: ConversationSort,
  before?: number,
): string => {
  const { sort: sortParam, order } = sortParams(sort);
  const search = new URLSearchParams();
  search.set('sort', sortParam);
  search.set('order', order);
  search.set('limit', '50');
  if (filters.channelId.trim() !== '') search.set('channelId', filters.channelId.trim());
  if (filters.userId.trim() !== '') search.set('userId', filters.userId.trim());
  if (filters.behaviourId.trim() !== '') search.set('behaviourId', filters.behaviourId.trim());
  if (filters.search.trim() !== '') search.set('search', filters.search.trim());
  if (before !== undefined) search.set('before', String(before));
  return `${CONVERSATIONS_URL}?${search.toString()}`;
};

export const conversationUrl = (id: string): string =>
  `${CONVERSATIONS_URL}/${encodeURIComponent(id)}`;

export const conversationEndUrl = (id: string): string => `${conversationUrl(id)}/end`;

export const conversationPageUrl = (id: string): string =>
  `/assistant/conversations/${encodeURIComponent(id)}`;
