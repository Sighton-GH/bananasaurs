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
  /** Round 1 may call any allowed read-only tool; rounds 2-4 are narrower (hard rule 3, ADR 0071). */
  readonly rounds: 'first' | 'all';
  /** Plain words for the cap the daemon enforces on this tool's result text. */
  readonly outputLimit: string;
  /** Ids of every skill (`CLUB_ASSISTANT_SKILLS`) whose use involves this tool. */
  readonly skills: readonly string[];
  /** The acting skill that must be allowed for the tool to be declared (B2a). */
  readonly actsForSkill?: string;
}

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
      "Search past messages in this Discord server's archived channels that the asking member can see. To check whether a particular member said something, pass their name as from.",
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
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club'],
  },
  {
    name: 'open_resource',
    description:
      'Open one of the club resources listed in the instructions by its resource id, with the outline of a document-like resource; or list the headings of one cached document by its doc id.',
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
    rounds: 'all',
    outputLimit: 'Up to 4,000 characters of cached content.',
    skills: ['search-club', 'open-resource', 'review-plan'],
  },
  {
    name: 'web_search',
    description:
      'Search the public web. Never put names, contact details or private club information in the query.',
    parameters: QUERY_PARAMETERS,
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club'],
  },
  {
    name: 'server_info',
    description: "The server's description and the channels the asking member can see.",
    parameters: NO_PARAMETERS,
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club', 'onboarding-guide'],
  },
  {
    name: 'current_time',
    description: "Today's date and the current time in the club's time zone.",
    parameters: NO_PARAMETERS,
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club', 'reminders'],
  },
  {
    name: 'my_reminders',
    description:
      "The asking member's own reminders that have not finished, with ids for edit_reminder and cancel_reminder. The server owner may pass all=true to see everyone's.",
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
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club', 'reminders'],
    actsForSkill: 'reminders',
  },
  {
    name: 'set_reminder',
    description:
      "Set a reminder. Only when the member asks for one. If the time, the channel or who to ping is unclear, ask the member instead of calling this. `when` is ISO 8601 with its UTC offset, in the club's time zone (use current_time first if you need today's date).",
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
  },
  {
    name: 'edit_reminder',
    description: 'Change one of your reminders by its id.',
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
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['reminders'],
    actsForSkill: 'reminders',
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel one of your reminders by its id.',
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
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['reminders'],
    actsForSkill: 'reminders',
  },
  {
    name: 'propose_memory',
    description:
      'Propose something for the club to remember. An owner reviews it before anything is remembered.',
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
  },
  {
    name: 'propose_decision',
    description: 'Propose a club decision. It is saved as a draft for owner review.',
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
  },
  {
    name: 'search_sources',
    description:
      'Search the cached club sources for passages about the query. Without a query it lists the cached sources, with their ids for read_chunk, open_resource and refresh_source.',
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
    rounds: 'first',
    outputLimit: 'Up to 30 lines, one per source, without a query; up to 6 hits otherwise.',
    skills: ['search-club'],
  },
  {
    name: 'read_chunk',
    description: 'Read one cached passage by its chunk id, with neighbouring passages.',
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
    rounds: 'all',
    outputLimit: 'Up to 4,000 characters including neighbours.',
    skills: ['search-club'],
  },
  {
    name: 'refresh_source',
    description:
      'Request a fresh fetch of one club source; updated content arrives in about a minute.',
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
    rounds: 'first',
    outputLimit: 'One line confirming the refresh.',
    skills: ['search-club'],
  },
  {
    name: 'search_conversations',
    description:
      'Look back at summaries of earlier conversations in channels everyone here can read.',
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
    rounds: 'first',
    outputLimit: RESULT_LIMIT,
    skills: ['search-club'],
  },
] as const;
