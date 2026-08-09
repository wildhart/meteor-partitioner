# wildhart:partitioner — local async migration build (Meteor 2.x)

This is a vendored copy of `wildhart:partitioner` for `/packages`, prepared as a
stepping stone for migrating the app from fibers to async/await **while staying
on Meteor 2.x**. Because it lives in `/packages` and keeps the same package
name, it automatically shadows the Atmosphere version.

## Why not just use PR #4 (the Meteor 3 branch)?

PR #4 is a Meteor-3-only rewrite (`api.versionsFrom(["3.0"])`) and cannot run
on Meteor 2.x. It also only hooks the `*Async` collection methods — but on
Meteor 2.x, Meteor's own internals (accounts, etc.) and any not-yet-converted
code still call the sync methods, which would silently **bypass partitioning**.
See the review notes in the chat for other issues found in that PR.

## Why this build is safe with async/await app code on Meteor 2.x

On Meteor 2.x every `*Async` collection/cursor method is a thin wrapper that
synchronously calls the corresponding sync method on the prototype
(`mongo/collection.js`, `ASYNC_COLLECTION_METHODS`). This package hooks the
sync methods, so `insertAsync`, `findOneAsync`, `cursor.fetchAsync`, etc. are
all intercepted automatically. Meteor 2.x async/await is fiber-backed, so
`Meteor.EnvironmentVariable` values (current group, direct-ops flag) are
preserved across `await`.

**This is NOT true on Meteor 3.** When you bump to 3.0, replace this vendored
copy with the (fixed) Meteor 3 branch. The async API names below were chosen to
match that branch, so app code will not need to change again.

## What changed vs published 3.0.2

1. New async public API (use these in app code from now on):

| Old (fiber, deprecated)              | New (async)                                   |
|--------------------------------------|-----------------------------------------------|
| `Partitioner.setUserGroup(u, g)`     | `await Partitioner.setUserGroupAsync(u, g)`    |
| `Partitioner.getUserGroup(u)`        | `await Partitioner.getUserGroupAsync(u)`       |
| `Partitioner.clearUserGroup(u)`      | `await Partitioner.clearUserGroupAsync(u)`     |
| `Partitioner.group()`                | `await Partitioner.groupAsync()` (client too)  |
| `Partitioner.bindUserGroup(u, fn)`   | `await Partitioner.bindUserGroupAsync(u, fn)`  |
| `Partitioner.addToGroup(c, id, g)`   | `await Partitioner.addToGroupAsync(c, id, g)`  |
| `Partitioner.removeFromGroup(...)`   | `await Partitioner.removeFromGroupAsync(...)`  |
| `Partitioner._isAdmin(id)`           | `await Partitioner._isAdminAsync(id)`          |

   `bindGroup(groupId, fn)` and `directOperation(fn)` are unchanged — both
   already accept async functions (the bound value survives `await` on 2.x).
   The old sync methods are kept intact so the app keeps working mid-migration.

2. `collection._partitionerDirect` now also exposes `findOneAsync`,
   `insertAsync`, `updateAsync`, `removeAsync` and `upsertAsync`, so direct
   (unpartitioned) operations can be written fiber-free.

3. `Partitioner.partitionCollection()` now prefers `createIndexAsync` and
   returns its promise — you can `await` it in server startup code.

4. `Accounts.createUserAsync` added to the list of accounts functions wrapped
   with `_searchAllUsers` (harmless on 2.x, needed on 3.0; `createUser` is
   still wrapped as before).

5. Everything else (hooks, allow/deny idiot-proofing, publication of
   `admin`/`group` fields, `wildhart:env-var-set` dependency) is unchanged
   from 3.0.2.

## App code checklist

- Replace the calls in the table above (grep for `Partitioner.`).
- Convert callbacks/sync collection calls in code running inside
  `bindGroup`/`bindUserGroup` to `await` — group binding survives `await`.
- Avoid escaping the fiber-aware promise chain (e.g. `setImmediate`, native
  timers, detached `.then()` chains) between binding a group and performing
  collection ops, otherwise `_currentGroup` will be unset — same rule as with
  fibers today.
