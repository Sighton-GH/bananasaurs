/**
 * Plain words for the audit trail's two jargon columns: "actor", "via"
 * and a claimed host user are internals, not product language.
 * The stored values are the server's vocabulary; these maps are the
 * dashboard's translation, kept beside the table so the Audit page and the
 * Overview's recent-activity list never drift apart.
 */

/** `actorType` values the server writes today; anything else passes through raw. */
const ACTOR_TYPE_LABEL: Record<string, string> = {
  owner: 'owner',
  operator_cli: 'operator',
  cli: 'operator',
  system: 'the bot',
  dashboard: 'dashboard account',
  account: 'dashboard account',
};

/** `via` values the server writes today; anything else passes through raw. */
const VIA_LABEL: Record<string, string> = {
  ssh: 'terminal (SSH)',
  http: 'dashboard',
};

export interface AuditActorParts {
  readonly actorType: string;
  readonly actorId: string | null;
  readonly actorUnixUserClaimed?: string | null;
  readonly via: string | null;
}

/**
 * The Audit page's Actor cell. A claimed host user is what the process
 * reported about itself, not a verified sign-in, so it is labelled
 * "unverified" rather than presented as fact.
 */
export function auditActorText(row: AuditActorParts): string {
  if (row.actorType === 'operator_cli' || row.actorType === 'cli') {
    return row.actorUnixUserClaimed != null && row.actorUnixUserClaimed !== ''
      ? `operator (host user ${row.actorUnixUserClaimed}, unverified)`
      : 'operator (terminal)';
  }
  const label = ACTOR_TYPE_LABEL[row.actorType] ?? row.actorType;
  if ((row.actorType === 'dashboard' || row.actorType === 'account') && row.actorId !== null) {
    return row.actorId;
  }
  return label;
}

/** The Via cell / "via" phrase: how the action reached the bot. */
export function auditViaText(via: string | null): string | null {
  if (via === null) return null;
  return VIA_LABEL[via] ?? via;
}

/**
 * The Overview recent-activity phrasing: the account id when one exists
 * (that is what a person recognises), else the plain actor label.
 */
export function auditActorCompact(row: AuditActorParts): string {
  if (row.actorId !== null) return row.actorId;
  return ACTOR_TYPE_LABEL[row.actorType] ?? row.actorType;
}
