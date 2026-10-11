import {
  CLUB_ASSISTANT_SKILLS,
  effectiveSkillScope,
  neutraliseMarkers,
  skillScopeAllows,
  type AssistantSkill,
  type SkillScopeMode,
} from '@bananasaurs/core';

/** One stored skill grant, matching the storage row shape without importing storage. */
export interface SkillAccessGrant {
  readonly skillId: string;
  readonly roleIds: readonly string[];
  readonly userIds?: readonly string[] | undefined;
  readonly mode?: SkillScopeMode | undefined;
}

export interface SkillAccessInput {
  readonly grants: readonly SkillAccessGrant[];
  readonly owner: boolean;
  readonly roleIds: readonly string[];
  readonly acting: {
    readonly skipActions: boolean;
    readonly invocationId: string | undefined;
  };
  readonly roleNames?: ((roleIds: readonly string[]) => ReadonlyMap<string, string>) | undefined;
}

export interface UnavailableSkill {
  readonly skill: AssistantSkill;
  readonly reason: string;
}

export interface SkillAccess {
  readonly skillAllowed: (skillId: string) => boolean;
  readonly permittedSkills: readonly AssistantSkill[];
  readonly unavailableSkills: readonly UnavailableSkill[];
}

const cleanRoleToken = (name: string): string =>
  neutraliseMarkers(name)
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The skill-scope gate from `service.ts`: the skill's effective scope is the
 * only gate, checked in code against the asker's live roles. Acting skills
 * additionally need a durable invocation id, and never run when actions are
 * skipped. Unavailable reasons come from the scope check alone, so skills
 * hidden only by the acting rule are never listed as unavailable.
 */
export const skillAccess = (input: SkillAccessInput): SkillAccess => {
  const grants = new Map(input.grants.map((grant) => [grant.skillId, grant]));
  const skillAllowed = (id: string): boolean => {
    const catalogueSkill = CLUB_ASSISTANT_SKILLS.find((candidate) => candidate.id === id);
    if (catalogueSkill === undefined) return false;
    if (
      catalogueSkill.acts &&
      (input.acting.skipActions === true || input.acting.invocationId === undefined)
    )
      return false;
    return skillScopeAllows(effectiveSkillScope(catalogueSkill, grants.get(id)), {
      owner: input.owner,
      roleIds: input.roleIds,
    });
  };
  const permittedSkills = CLUB_ASSISTANT_SKILLS.filter((candidate) => skillAllowed(candidate.id));
  const unavailableSkills: readonly UnavailableSkill[] = CLUB_ASSISTANT_SKILLS.filter(
    (candidate) => {
      const scope = effectiveSkillScope(candidate, grants.get(candidate.id));
      return !skillScopeAllows(scope, { owner: input.owner, roleIds: input.roleIds });
    },
  ).map((candidate) => {
    const scope = effectiveSkillScope(candidate, grants.get(candidate.id));
    if (scope.mode === 'owner') return { skill: candidate, reason: 'owner only' };
    if (scope.mode === 'roles') {
      const known = input.roleNames?.(scope.roleIds) ?? new Map<string, string>();
      const names = scope.roleIds
        .map((roleId) => known.get(roleId))
        .filter((name): name is string => name !== undefined);
      const cleaned = names.map(cleanRoleToken).filter((name) => name !== '');
      if (cleaned.length === 0) return { skill: candidate, reason: 'only for certain roles' };
      return { skill: candidate, reason: `only for ${cleaned.join(', ')}` };
    }
    return { skill: candidate, reason: 'only for certain roles' };
  });
  return { skillAllowed, permittedSkills, unavailableSkills };
};
