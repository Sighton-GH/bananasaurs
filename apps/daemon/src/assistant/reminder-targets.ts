import { PermissionsBitField } from 'discord.js';

/** The slice of a discord.js Guild this module needs. */
export interface ReminderTargetGuild {
  readonly channels: {
    readonly cache: ReadonlyMap<
      string,
      { readonly id: string; readonly name: string; isTextBased(): boolean; isThread(): boolean }
    >;
  };
  readonly roles: {
    readonly cache: ReadonlyMap<
      string,
      { readonly id: string; readonly name: string; readonly mentionable: boolean }
    >;
  };
  readonly members: {
    readonly me: ReminderTargetMember | null;
    readonly cache: ReadonlyMap<string, ReminderTargetMember>;
    fetch(userId: string): Promise<ReminderTargetMember>;
    /** discord.js `members.search({ query, limit })`: prefix search on username/nickname. */
    search(options: {
      query: string;
      limit: number;
    }): Promise<ReadonlyMap<string, ReminderTargetMember>>;
  };
}

export interface ReminderTargetMember {
  readonly id: string;
  readonly displayName: string;
  readonly user: { readonly username: string };
  permissionsIn(channel: { readonly id: string }): { has(permission: bigint): boolean };
}

export interface ReminderTargetRequest {
  readonly askerId: string;
  /** Channel as given: id, <#id>, #name or name. Undefined means the channel the request came from. */
  readonly channel?: string | undefined;
  readonly currentChannelId: string;
  readonly members: readonly string[];
  readonly roles: readonly string[];
}

export interface ResolvedReminderTargets {
  readonly channelId: string;
  readonly channelName: string;
  readonly mentions: {
    readonly userIds: readonly string[];
    readonly roleIds: readonly string[];
    readonly everyone: boolean;
    readonly here: boolean;
  };
  /** Human-readable names in the same order, for the confirmation summary. */
  readonly memberNames: readonly string[];
  readonly roleNames: readonly string[];
}

export type ReminderTargetResult =
  | { readonly ok: true; readonly targets: ResolvedReminderTargets }
  | { readonly ok: false; readonly problem: string };

const UNAVAILABLE = "I can't check permissions right now, so I didn't set the reminder.";
const ID_PATTERN = /^\d{17,20}$/;
const mentionId = (value: string, pattern: RegExp): string | undefined => pattern.exec(value)?.[1];
const failure = (problem: string): ReminderTargetResult => ({ ok: false, problem });

const ambiguousProblem = (
  kind: string,
  value: string,
  candidates: readonly { name: string; id: string }[],
) =>
  `"${value}" matches more than one ${kind}: ${candidates
    .slice(0, 5)
    .map((candidate) => `${candidate.name} (${candidate.id})`)
    .join(', ')}.`;

export const resolveReminderTargets = async (
  guild: ReminderTargetGuild | undefined,
  request: ReminderTargetRequest,
): Promise<ReminderTargetResult> => {
  try {
    if (guild === undefined || guild.members.me === null) return failure(UNAVAILABLE);

    const asker = await guild.members.fetch(request.askerId);
    const requestedChannel = request.channel ?? request.currentChannelId;
    const channelId =
      mentionId(requestedChannel, /^<#(\d{17,20})>$/) ??
      (ID_PATTERN.test(requestedChannel) ? requestedChannel : undefined);
    const channelQuery = channelId === undefined ? requestedChannel.replace(/^#/, '') : undefined;
    const matchingChannels = [...guild.channels.cache.values()].filter((candidate) => {
      if (channelId !== undefined) return candidate.id === channelId;
      return candidate.name.toLowerCase() === channelQuery?.toLowerCase();
    });
    const visibleChannels = matchingChannels.filter((candidate) =>
      asker.permissionsIn(candidate).has(PermissionsBitField.Flags.ViewChannel),
    );
    const usableChannels = visibleChannels.filter(
      (candidate) => candidate.isTextBased() && !candidate.isThread(),
    );
    if (usableChannels.length === 0) {
      const visibleNonText = visibleChannels.find(
        (candidate) => !candidate.isTextBased() || candidate.isThread(),
      );
      if (visibleNonText !== undefined) {
        return failure(`I can't post reminders in #${visibleNonText.name}.`);
      }
      return failure(`I can't find a channel called "${requestedChannel}".`);
    }
    if (usableChannels.length > 1)
      return failure(ambiguousProblem('channel', requestedChannel, usableChannels));
    const channel = usableChannels[0];
    if (channel === undefined) {
      return failure(`I can't find a channel called "${requestedChannel}".`);
    }

    const bot = guild.members.me;
    const view = PermissionsBitField.Flags.ViewChannel;
    const send = PermissionsBitField.Flags.SendMessages;
    if (!asker.permissionsIn(channel).has(view) || !asker.permissionsIn(channel).has(send)) {
      return failure(
        `You can't send messages in #${channel.name}, so I can't post a reminder there.`,
      );
    }
    if (!bot.permissionsIn(channel).has(view) || !bot.permissionsIn(channel).has(send)) {
      return failure(`I don't have permission to send messages in #${channel.name}.`);
    }

    if (request.members.length > 50) return failure("That's more than 25 people for one reminder.");
    const userIds: string[] = [];
    const memberNames: string[] = [];
    const seenUsers = new Set<string>();
    for (const raw of request.members) {
      const value = raw.replace(/^@/, '');
      const id =
        mentionId(value, /^<@!?([0-9]{17,20})>$/) ?? (ID_PATTERN.test(value) ? value : undefined);
      let found: ReminderTargetMember[];
      if (id !== undefined) {
        found = [await guild.members.fetch(id)];
      } else {
        let searched: ReminderTargetMember[];
        try {
          searched = [...(await guild.members.search({ query: value, limit: 5 })).values()];
        } catch {
          return failure("I couldn't look up members right now, so I didn't set the reminder.");
        }
        const allMatches = [
          ...new Map(
            [...guild.members.cache.values(), ...searched].map((candidate) => [
              candidate.id,
              candidate,
            ]),
          ).values(),
        ];
        const displayMatches = allMatches.filter(
          (candidate) => candidate.displayName.toLowerCase() === value.toLowerCase(),
        );
        found =
          displayMatches.length > 0
            ? displayMatches
            : allMatches.filter(
                (candidate) => candidate.user.username.toLowerCase() === value.toLowerCase(),
              );
      }
      if (found.length === 0) return failure(`I can't find a member called "${raw}".`);
      if (found.length > 1)
        return failure(
          ambiguousProblem(
            'member',
            raw,
            found.map((candidate) => ({ name: candidate.displayName, id: candidate.id })),
          ),
        );
      const resolved = found[0];
      if (resolved !== undefined && !seenUsers.has(resolved.id)) {
        seenUsers.add(resolved.id);
        userIds.push(resolved.id);
        memberNames.push(resolved.displayName);
        if (userIds.length > 25) return failure("That's more than 25 people for one reminder.");
      }
    }

    if (request.roles.length > 20) return failure("That's more than 10 roles for one reminder.");
    const roleIds: string[] = [];
    const roleNames: string[] = [];
    const seenRoles = new Set<string>();
    let everyone = false;
    let here = false;
    let nonMentionableRole: string | undefined;
    for (const raw of request.roles) {
      const value = raw.replace(/^@/, '');
      if (value.toLowerCase() === 'everyone') {
        everyone = true;
        continue;
      }
      if (value.toLowerCase() === 'here') {
        here = true;
        continue;
      }
      const id =
        mentionId(value, /^<@&([0-9]{17,20})>$/) ?? (ID_PATTERN.test(value) ? value : undefined);
      const matches = [...guild.roles.cache.values()].filter((role) =>
        id === undefined ? role.name.toLowerCase() === value.toLowerCase() : role.id === id,
      );
      if (matches.length === 0) return failure(`I can't find a role called "${raw}".`);
      if (matches.length > 1) return failure(ambiguousProblem('role', raw, matches));
      const role = matches[0];
      if (role !== undefined && !seenRoles.has(role.id)) {
        seenRoles.add(role.id);
        roleIds.push(role.id);
        roleNames.push(role.name);
        if (roleIds.length > 10) return failure("That's more than 10 roles for one reminder.");
        if (!role.mentionable) nonMentionableRole ??= role.name;
      }
    }

    if (everyone || here || nonMentionableRole !== undefined) {
      if (!asker.permissionsIn(channel).has(PermissionsBitField.Flags.MentionEveryone)) {
        const target =
          nonMentionableRole === undefined
            ? '@everyone, @here or a role'
            : `@everyone, @here or the ${nonMentionableRole} role`;
        return failure(
          `Pinging ${target} needs the Mention Everyone permission in #${channel.name}.`,
        );
      }
    }

    return {
      ok: true,
      targets: {
        channelId: channel.id,
        channelName: channel.name,
        mentions: { userIds, roleIds, everyone, here },
        memberNames,
        roleNames,
      },
    };
  } catch {
    return failure(UNAVAILABLE);
  }
};
