/**
 * The static description of every read-only tool the assistant can call
 * (ADR 0067). This lives in core, not in the daemon, because the HTTP
 * package's skill detail route (`GET /api/assistant/skills/:skillId`) needs
 * it too and cannot import from `apps/daemon`. `apps/daemon/src/assistant/tools.ts`
 * derives its `toolDeclarations` from this catalogue so a declaration can
 * never drift from the description shown on the dashboard.
 */

/** One property of a tool's JSON Schema parameters object. */
export interface JSONSchemaProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  readonly description?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly (string | number)[];
  readonly items?: {
    readonly type: 'string' | 'integer' | 'number';
    readonly minimum?: number;
    readonly maximum?: number;
  };
  readonly maxItems?: number;
  readonly properties?: Readonly<Record<string, JSONSchemaProperty>>;
  readonly required?: readonly string[];
}

/**
 * A tool's parameters, in JSON Schema shape. Carries its own index signature
 * so it is directly assignable to `ToolDeclaration.parameters`
 * (`Readonly<Record<string, unknown>>`) without a cast.
 */
export interface JSONSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JSONSchemaProperty>>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
}

export interface ToolCatalogueEntry {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  /**
   * Which rounds may call this tool. `first` runs only in round 1;
   * `all` runs in any round; `returned-id` runs in a follow-up round only
   * (it needs an id an earlier result returned). Hard rule 3, ADR 0071.
   */
  readonly rounds: 'first' | 'all' | 'returned-id';
  /** Plain words for the cap the daemon enforces on this tool's result text. */
  readonly outputLimit: string;
  /** Ids of every skill (`CLUB_ASSISTANT_SKILLS`) whose use involves this tool. */
  readonly skills: readonly string[];
  /** The acting skill that must be allowed for the tool to be declared (B2a). */
  readonly actsForSkill?: string;
  /** Capability group this tool belongs to (ADR 0136). */
  readonly group: ToolGroupId;
  /** The skill that must be allowed for the tool to be declared, beyond `skills`. */
  readonly requiresSkill?: string;
  /** Marks the tools that change state; they never run in every round. */
  readonly writes?: true;
}

export type ToolGroupId =
  'reminders' | 'club-knowledge' | 'channel' | 'web' | 'server' | 'time' | 'proposals';

export const TOOL_GROUPS: readonly {
  readonly id: ToolGroupId;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: 'reminders',
    label: 'Reminders and scheduled posts',
    description:
      'post a message later in a channel, once or repeating, and ping members or roles; list, change or cancel ones the member set',
  },
  {
    id: 'club-knowledge',
    label: 'Club knowledge',
    description:
      "search and read the club's reviewed sources, archived messages and earlier conversation summaries",
  },
  {
    id: 'channel',
    label: 'This channel',
    description: 'read older messages in the current channel',
  },
  {
    id: 'web',
    label: 'The web',
    description:
      'current events, facts, how-tos and anything general you are not sure of; check club sources first for club questions',
  },
  { id: 'server', label: 'This server', description: "the server's channels and upcoming events" },
  { id: 'time', label: 'Time', description: "today's date and time in the club's time zone" },
  {
    id: 'proposals',
    label: 'Proposals for owner review',
    description:
      'propose something for the club to remember, or draft a decision record; an owner reviews it',
  },
];

const QUERY_PARAMETERS: JSONSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'What to search for.',
      minLength: 1,
      maxLength: 200,
    },
  },
  required: ['query'],
};

const NO_PARAMETERS: JSONSchema = { type: 'object', properties: {} };

const RESULT_LIMIT = 'Up to 6,000 characters of results.';

// The search/question-answering skill ('search-club') can reach for any of
// these on its own, so it is listed on every entry; the rest of the `skills`
// lists are the other catalogue skills whose description names this tool.
export const TOOL_CATALOGUE: readonly ToolCatalogueEntry[] = [
  {
    name: 'search_archive',
    description:
      "Search past messages in this server's archived channels that the asking member can see. Use it when a member asks what was said or decided in the server, or when club sources have nothing. Don't use it to collect what one person said. To check whether a particular member said something, pass their name as from.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for.',
          minLength: 1,
          maxLength: 200,
        },
        from: {
          type: 'string',
          description:
            "Only when checking whether one specific member said something: that member's name. Never use it to collect or summarise what someone said.",
          maxLength: 100,
        },
      },
      required: ['query'],
    },
    rounds: 'all',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club'],
    group: 'club-knowledge',
  },
  {
    name: 'open_resource',
    description:
      'Open one club resource by its resource id (with an outline of a document), or list the headings of one cached document by its doc id. Use it when a member wants a link or an overview of a known resource, or after search_sources returned a doc id. Give either resourceId or docId.',
    parameters: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'string',
          description: 'The resource id. Give either this or docId.',
          minLength: 1,
          maxLength: 64,
        },
        docId: {
          type: 'string',
          description:
            'The doc id from search_sources, read_chunk or open_resource. Give either this or resourceId.',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: [],
    },
    rounds: 'returned-id',
    outputLimit: 'Up to 4,000 characters of cached content.',
    skills: ['search-club', 'open-resource', 'review-plan'],
    group: 'club-knowledge',
  },
  {
    name: 'web_search',
    description:
      "Search the public web. Use it when the question is general or about current events, or when club sources came up empty; check club sources first for anything about the club. Don't guess or say you don't know before trying it. Never put names, contact details or private club information in the query.",
    parameters: QUERY_PARAMETERS,
    rounds: 'all',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club', 'web-search'],
    group: 'web',
    requiresSkill: 'web-search',
  },
  {
    name: 'server_info',
    description:
      "The server's description and the channels the asking member can see. Use it when a member asks where something is or which channel to use, or for new-member questions. It does not list members.",
    parameters: NO_PARAMETERS,
    rounds: 'all',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club', 'onboarding-guide'],
    group: 'server',
  },
  {
    name: 'current_time',
    description:
      "Today's date and the current time in the club's time zone. The date and time are already in your instructions under NOW; use this only if you need the time again later in a long answer.",
    parameters: NO_PARAMETERS,
    rounds: 'all',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club', 'reminders'],
    group: 'time',
  },
  {
    name: 'my_reminders',
    description:
      "The asking member's unfinished reminders and scheduled posts, with ids for edit_reminder and cancel_reminder. Use it when a member asks what is scheduled, or before changing or cancelling one. The server owner may pass all=true to see everyone's.",
    parameters: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: "Owner only: list everyone's unfinished reminders.",
        },
      },
      required: [],
    },
    rounds: 'all',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club', 'reminders'],
    actsForSkill: 'reminders',
    group: 'reminders',
  },
  {
    name: 'set_reminder',
    description:
      "Schedule a message in a channel, once or repeating, that can ping members or roles. Use it whenever a member asks to be reminded, to remind or nag someone, or to post something later. If the time is unclear, ask. Omit channel for this channel. members takes display names exactly as written in the chat. when is ISO 8601 with its UTC offset in the club's time zone; today's date is under NOW. Example: \"remind Claire at 23:00 to go to sleep\" becomes text \"go to sleep\", when \"2026-10-10T23:00:00-07:00\", members: [\"Claire H\"].",
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'What the reminder says.',
          minLength: 1,
          maxLength: 1500,
        },
        when: {
          type: 'string',
          description: 'ISO 8601 date-time with its UTC offset.',
        },
        context: {
          type: 'string',
          description: 'Why it was set, in a few words.',
          maxLength: 300,
        },
        channel: {
          type: 'string',
          description: 'A channel name, #name or id; omit for this channel.',
        },
        members: {
          type: 'array',
          description: 'Names or ids to ping (at most 25).',
          items: { type: 'string' },
          maxItems: 25,
        },
        roles: {
          type: 'array',
          description: 'Role names or ids; "everyone" or "here" for those pings (at most 10).',
          items: { type: 'string' },
          maxItems: 10,
        },
        repeat: {
          type: 'object',
          description: 'Repeat pattern for the reminder.',
          properties: {
            kind: {
              type: 'string',
              enum: ['daily', 'weekdays', 'weekly', 'monthly'],
            },
            days: {
              type: 'array',
              description: 'Weekdays for weekly (0-6, Sunday=0).',
              items: { type: 'integer', minimum: 0, maximum: 6 },
              maxItems: 7,
            },
            everyWeeks: {
              type: 'integer',
              description: 'Every N weeks (1-12).',
              minimum: 1,
              maximum: 12,
            },
            dayOfMonth: {
              type: 'integer',
              description: 'Day of month for monthly (1-31).',
              minimum: 1,
              maximum: 31,
            },
            until: {
              type: 'string',
              description: 'ISO 8601 date-time with offset; repeats stop after it.',
            },
            count: {
              type: 'integer',
              description: 'Stop after this many deliveries (1-1000).',
              minimum: 1,
              maximum: 1000,
            },
          },
          required: ['kind'],
        },
      },
      required: ['text', 'when'],
    },
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['reminders'],
    actsForSkill: 'reminders',
    group: 'reminders',
    writes: true,
  },
  {
    name: 'edit_reminder',
    description:
      "Change one of the asking member's reminders by its id (from my_reminders): text, time, channel, pings or repeat. Use it when a member asks to move, reword or stop repeating a reminder they set.",
    parameters: {
      type: 'object',
      properties: {
        reminderId: {
          type: 'string',
          description: 'The reminder id from my_reminders.',
          minLength: 1,
          maxLength: 128,
        },
        text: {
          type: 'string',
          description: 'New reminder text.',
          minLength: 1,
          maxLength: 1500,
        },
        when: {
          type: 'string',
          description: 'New due time, ISO 8601 with its UTC offset.',
        },
        context: {
          type: 'string',
          description: 'New reason line.',
          maxLength: 300,
        },
        channel: {
          type: 'string',
          description: 'A channel name, #name or id.',
        },
        members: {
          type: 'array',
          description: 'Names or ids to ping (at most 25).',
          items: { type: 'string' },
          maxItems: 25,
        },
        roles: {
          type: 'array',
          description: 'Role names or ids (at most 10).',
          items: { type: 'string' },
          maxItems: 10,
        },
        repeat: {
          type: 'object',
          description: 'New repeat pattern.',
          properties: {
            kind: {
              type: 'string',
              enum: ['daily', 'weekdays', 'weekly', 'monthly'],
            },
            days: {
              type: 'array',
              items: { type: 'integer', minimum: 0, maximum: 6 },
              maxItems: 7,
            },
            everyWeeks: { type: 'integer', minimum: 1, maximum: 12 },
            dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
            until: { type: 'string' },
            count: { type: 'integer', minimum: 1, maximum: 1000 },
          },
          required: ['kind'],
        },
        stopRepeating: {
          type: 'boolean',
          description: 'True to make a repeating reminder one-off.',
        },
      },
      required: ['reminderId'],
    },
    rounds: 'returned-id',
    outputLimit: RESULT_LIMIT,
    skills: ['reminders'],
    actsForSkill: 'reminders',
    group: 'reminders',
    writes: true,
  },
  {
    name: 'cancel_reminder',
    description:
      "Cancel one of the asking member's reminders by its id (from my_reminders). Use it when a member asks to cancel or delete a reminder they set. If several match, ask which.",
    parameters: {
      type: 'object',
      properties: {
        reminderId: {
          type: 'string',
          description: 'The reminder id from my_reminders.',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ['reminderId'],
    },
    rounds: 'returned-id',
    outputLimit: RESULT_LIMIT,
    skills: ['reminders'],
    actsForSkill: 'reminders',
    group: 'reminders',
    writes: true,
  },
  {
    name: 'propose_memory',
    description:
      "Propose something for the club to remember long term (a fact, preference or rule). An owner reviews it before anything is remembered. Use it when a member asks the bot to remember something about the club. Don't use it for one-off details.",
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'What should be remembered.',
          minLength: 1,
          maxLength: 1000,
        },
        section: {
          type: 'string',
          description: 'Memory section for the proposal.',
          maxLength: 100,
        },
      },
      required: ['content'],
    },
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['propose-memory'],
    actsForSkill: 'propose-memory',
    group: 'proposals',
    writes: true,
  },
  {
    name: 'propose_decision',
    description:
      "Save a club decision as a draft for owner review, with what was decided. Use it when a member asks to record a decision or to review a plan as a draft. Nothing becomes policy until an owner approves it.",
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'What was decided.',
          minLength: 1,
          maxLength: 4000,
        },
        kind: {
          type: 'string',
          enum: ['decision', 'review-plan'],
        },
      },
      required: ['summary', 'kind'],
    },
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['record-decision'],
    actsForSkill: 'record-decision',
    group: 'proposals',
    writes: true,
  },
  {
    name: 'search_sources',
    description:
      "Search the club's cached sources (website, docs, repositories) for passages about the query; without a query it lists the sources with their ids. Use it first for any question about the club, its events, rules or projects. Follow up with read_chunk to read a hit in full.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for. Omit it to list the cached sources.',
          minLength: 2,
          maxLength: 200,
        },
        filter: {
          type: 'string',
          description:
            'Only sources whose id or title contains this text. Only used when query is omitted.',
          minLength: 1,
          maxLength: 80,
        },
        sourceIds: {
          type: 'array',
          description: 'Only these source ids (at most 10).',
          items: { type: 'string' },
          maxItems: 10,
        },
      },
      required: [],
    },
    rounds: 'all',
    outputLimit: 'Up to 30 lines, one per source, without a query; up to 6 hits otherwise.',
    skills: ['search-club'],
    group: 'club-knowledge',
  },
  {
    name: 'read_chunk',
    description:
      "Read one cached passage by its chunk id, with neighbouring passages. Use it after search_sources or open_resource returned a chunk id and you need the full text to answer accurately.",
    parameters: {
      type: 'object',
      properties: {
        chunkId: {
          type: 'string',
          description: 'The chunk id from search_sources, read_chunk or open_resource.',
          minLength: 1,
          maxLength: 128,
        },
        neighbours: {
          type: 'integer',
          description: 'How many neighbouring chunks on each side (0, 1 or 2).',
          enum: [0, 1, 2],
        },
      },
      required: ['chunkId'],
    },
    rounds: 'returned-id',
    outputLimit: 'Up to 4,000 characters including neighbours.',
    skills: ['search-club'],
    group: 'club-knowledge',
  },
  {
    name: 'refresh_source',
    description:
      "Ask for a fresh fetch of one club source; updated content arrives in about a minute. Use it when a member says a source is out of date or a page changed recently. Then answer from what you have now and say it is refreshing.",
    parameters: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'string',
          description: 'The resource id.',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['resourceId'],
    },
    // refresh_source only enqueues a refresh job. That is a side effect, but
    // not a Discord write; it is idempotent per 10-minute bucket and has no
    // member-visible effect, so it may run in any round.
    rounds: 'all',
    outputLimit: 'One line confirming the refresh.',
    skills: ['search-club'],
    group: 'club-knowledge',
  },
  {
    name: 'upcoming_events',
    description:
      "Upcoming Discord scheduled events and channel reminders in the next 30 days, soonest first. Use it when a member asks what's coming up, when the next meeting is, or what's scheduled.",
    parameters: NO_PARAMETERS,
    rounds: 'all',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club'],
    group: 'server',
  },
  {
    name: 'search_conversations',
    description:
      'Search summaries of earlier conversations with the bot in channels everyone here can read. Use it when a member refers to something discussed with the bot before, such as "what did we decide last week".',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for.',
          minLength: 2,
          maxLength: 200,
        },
      },
      required: ['query'],
    },
    rounds: 'all',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club'],
    group: 'club-knowledge',
  },
  {
    name: 'channel_history',
    description:
      "Read older messages in the current channel, paging back with the before id from an earlier result. Use it when a member asks to summarise or catch up on the conversation, or refers to something said earlier here.",
    parameters: {
      type: 'object',
      properties: {
        before: {
          type: 'string',
          description: 'A message id from an earlier channel_history result in this request.',
          minLength: 17,
          maxLength: 20,
        },
        limit: {
          type: 'integer',
          description: 'How many older messages to read (1-50).',
          minimum: 1,
          maximum: 50,
        },
      },
      required: [],
    },
    rounds: 'returned-id',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club'],
    group: 'channel',
  },
] as const;

const ID_ARG_NAMES: Readonly<Record<string, readonly string[]>> = {
  read_chunk: ['chunkId'],
  open_resource: ['resourceId', 'docId'],
  channel_history: ['before'],
  edit_reminder: ['reminderId'],
  cancel_reminder: ['reminderId'],
};
export const RETURNED_ID_ARGS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  TOOL_CATALOGUE.filter((e) => e.rounds === 'returned-id').map((e) => [
    e.name,
    ID_ARG_NAMES[e.name] ?? [],
  ]),
);
