# @linkalive/database

LinkAlive's MySQL 8.x source of truth. The same schema and baseline migration
are also tested against MariaDB 11.x, which is used for local development. The
Prisma schema exposes camelCase fields while tables and columns use snake_case.

## Commands

Run the workspace aliases from the repository root:

```sh
pnpm db:generate
pnpm db:migrate
pnpm db:deploy
pnpm db:retention
```

Or invoke this package's Prisma scripts directly:

```sh
pnpm --filter @linkalive/database prisma:generate
pnpm --filter @linkalive/database prisma:validate
pnpm --filter @linkalive/database prisma:deploy
```

`DATABASE_URL` must be set for validation and migration commands.

`pnpm db:retention` is the only built-in retention entry point. It is an
explicit, bounded maintenance command rather than an application background
loop. It deletes child rows before their `RESTRICT` parents in small
transactions and holds a connection-scoped MySQL named lock for the entire run.
Configure it with `RETENTION_CHECK_RESULT_DAYS`, `RETENTION_HISTORY_DAYS`,
`RETENTION_BATCH_SIZE`, and `RETENTION_MAX_BATCHES_PER_STEP`.

Before age-based deletion, retention also backfills secret disposal in bounded
batches. Soft-deleted monitor URLs, soft-deleted notification channel configs,
and terminal outbox config snapshots that cannot be retried or used to create a
recovery are replaced with a non-empty opaque tombstone. The `BLOB NOT NULL`
contract remains intact and accidental decrypt attempts fail closed. The JSON
result reports these updates separately as `secretRedactions` and
`totalRedacted`; they are not included in `totalDeleted`.

## Important invariants

The clean baseline SQL migration contains database constraints Prisma cannot
express:

- one active (`PENDING`, `ENQUEUED`, `RUNNING`) scheduled check per monitor;
- one `OPEN` incident per monitor;
- allowed monitor intervals, thresholds, timing and expected/observed status-code ranges;
- coherent incident closure timestamps/reasons;
- scheduled/manual/test result ledger consistency, including an exact
  `(scheduled_check_id, monitor_id, config_version)` identity match for scheduled
  results;
- safe URL snapshots and notification sequencing.

Observed HTTP response codes are stored across the full three-digit protocol
range (`100`-`999`), while monitor expectations intentionally remain limited to
the conventional `100`-`599` range. Pre-save `TEST` results have no monitor or
configuration version; their `display_url_snapshot` is the safe, credential- and
query-free target shown to users.

MySQL has no partial unique indexes. The migration instead uses ignored,
generated columns plus unique indexes:

- `scheduled_checks.active_monitor_id` permits only one `PENDING`, `ENQUEUED`,
  or `RUNNING` row per monitor;
- `incidents.open_monitor_id` permits only one `OPEN` row per monitor.

Do not replace the checked-in migration with a freshly generated baseline or
turn those generated columns into writable columns. Prisma cannot fully express
these generated-column and custom-check contracts, so future migrations must
preserve them deliberately. The checked-in retention indexes must also remain.

MySQL `DATETIME(3)` has no timezone metadata. LinkAlive treats every stored
timestamp as UTC; processes should use a `mysql://` URL and UTC session/client
timezone settings. IDs are UUID strings stored as `CHAR(36)` and encrypted
values use non-null `BLOB` columns.

The `prisma` export is process-scoped and safe for development hot reload. Call
`prisma.$disconnect()` only during actual process shutdown, never per request.
