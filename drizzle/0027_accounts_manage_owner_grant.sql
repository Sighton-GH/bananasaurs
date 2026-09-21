-- ADR 0056: `accounts.manage` is a new capability, and bootstrap only issues
-- the capabilities that exist at bootstrap time. Every owner account already on
-- the instance would otherwise lose web access to account management the
-- moment the routes are re-gated. Owners hold every capability by definition
-- (docs/19 §6.10 step 3), so this is the grant bootstrap would have made.
--
-- Data-only and hand-written, the bounded exception ADR 0049 D1 allows. Scoped
-- exactly as bootstrap scopes it: one row per (guild, owner) pair the owner can
-- already reach. `INSERT OR IGNORE` against the primary key makes a re-run a
-- no-op. `granted_at` is epoch milliseconds, the unit every `*_at` column uses.
INSERT OR IGNORE INTO account_capabilities (guild_id, account_id, capability, granted_at, granted_by)
SELECT access.guild_id, access.account_id, 'accounts.manage', CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'migration-0027'
FROM account_guild_access AS access
JOIN dashboard_accounts AS account ON account.account_id = access.account_id
WHERE account.is_owner = 1;
