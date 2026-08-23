/**
 * The Discord failures Release 1 must handle by name rather than by string
 * matching. Everything the effect gateway branches on appears here.
 */
export const DiscordErrorCode = {
  UnknownMessage: 10008,
  UnknownMember: 10007,
  UnknownRole: 10011,
  MissingAccess: 50001,
  MissingPermissions: 50013,
  /**
   * The interaction token is gone: not acknowledged within three seconds, or
   * followed up more than fifteen minutes later. Discord discards the token
   * rather than queueing, so this is unrecoverable — the member sees nothing.
   */
  UnknownInteraction: 10062,
  /** Target's highest role is at or above the bot's. Discord reports 50013. */
  RateLimited: 429,
} as const;

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
    readonly options: {
      /** Seconds. Present on 429. */
      retryAfter?: number | undefined;
      /** A global 429 pauses every route, not just this one. */
      global?: boolean | undefined;
    } = {},
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  /**
   * True when Discord refused because of permissions or hierarchy. The API
   * cannot distinguish the two — both are 50013 — so the caller must check
   * hierarchy itself before acting rather than inferring it from the error.
   */
  get isPermissionDenied(): boolean {
    return (
      this.code === DiscordErrorCode.MissingPermissions ||
      this.code === DiscordErrorCode.MissingAccess
    );
  }

  /** The target no longer exists. Not retryable; the panel or role is stale. */
  get isGone(): boolean {
    return (
      this.code === DiscordErrorCode.UnknownMessage ||
      this.code === DiscordErrorCode.UnknownMember ||
      this.code === DiscordErrorCode.UnknownRole
    );
  }

  /** We were too slow to acknowledge. The role change may still have happened. */
  get isExpiredInteraction(): boolean {
    return this.code === DiscordErrorCode.UnknownInteraction;
  }
}

/**
 * Raised when a role mutation is refused locally because the role sits at or
 * above the bot's highest role, or is integration-managed.
 *
 * Deliberately distinct from DiscordApiError: this is our own pre-flight check
 * (docs/18, and the `role.managed` case the planning documents missed), and it
 * must never be confused with Discord having refused the call.
 */
export class RoleHierarchyError extends Error {
  constructor(
    readonly roleId: string,
    readonly reason: 'above_bot' | 'managed' | 'is_everyone',
  ) {
    super(`role ${roleId} is not assignable: ${reason}`);
    this.name = 'RoleHierarchyError';
  }
}
