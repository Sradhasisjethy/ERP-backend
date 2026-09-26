/**
 * Remembers, for a few seconds, the two facts `authenticate` checks on every
 * request: a user's permissions version and account status.
 *
 * Why: that check was a database round trip in front of every API call, done
 * before the handler could start its own queries. Against the remote database
 * it was ~30 ms of an ~80 ms table request, and opening a module fires several.
 * The answer almost never changes between one request and the next.
 *
 * Why it is still safe: the entry is dropped the moment this process changes
 * the answer — a permissions bump (role edits, membership changes, role
 * deactivation; see utils/permissionVersion.js) or any write to a user row
 * (status, deletion; see the hooks in users/user.model.js). A change made
 * inside a transaction is dropped again after it commits, so a request that
 * read the old row mid-transaction cannot keep it. What remains is a change
 * made by *another* process — a second app instance, or SQL run by hand —
 * which is seen within TTL_MS. That bound is the trade, and it is small next
 * to the hour a token lived before revocation existed at all.
 */

const TTL_MS = 10 * 1000;
const MAX_ENTRIES = 10000;
const entries = new Map();

const get = (userId) => {
  const entry = entries.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(userId);
    return null;
  }
  return entry.value;
};

const set = (userId, value) => {
  // Bounded so a flood of distinct tokens cannot grow memory without limit;
  // dropping everything is crude but only costs one lookup per active user.
  if (entries.size >= MAX_ENTRIES) entries.clear();
  entries.set(userId, { value, expiresAt: Date.now() + TTL_MS });
};

/**
 * Forget these users now, and again once `transaction` commits — the second
 * pass covers a request that re-read the pre-change row in between.
 */
const invalidate = (userIds, transaction) => {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  const drop = () => ids.forEach((id) => entries.delete(id));
  drop();
  if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(drop);
};

/** For writes whose affected users are not known individually. */
const clear = (transaction) => {
  entries.clear();
  if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(() => entries.clear());
};

module.exports = { sessionStateCache: { get, set, invalidate, clear }, SESSION_STATE_TTL_MS: TTL_MS };
