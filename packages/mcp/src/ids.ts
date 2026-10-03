import { parseSnowflakeId } from '@bananasaurs/core';

/**
 * Every id a tool validates before the guild gate, in one place: each tool
 * module used to carry its own copy. A malformed id is false — the caller
 * answers the argument fault or the shared refusal — never a throw.
 */
export const idsAreWellFormed = (ids: readonly unknown[]): boolean => {
  try {
    for (const id of ids) parseSnowflakeId(id);
    return true;
  } catch {
    return false;
  }
};
