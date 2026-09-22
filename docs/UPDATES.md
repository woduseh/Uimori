# Linux/Docker updates

Uimori has a persistent maintenance mode and an operator CLI for updating a Compose installation. The in-app Update button and release catalog integration are not implemented. The controller's Docker workflow has not yet been verified on a real Docker host. For installation, see [SELF-HOST](SELF-HOST.md); the separate Oracle deployment tool is documented in [ORACLE-RELEASE](ORACLE-RELEASE.md).

## Manual release update

Use this path for source installations; see [SELF-HOST](SELF-HOST.md#저장과-운영) for manual Compose operations. Keep the existing Oracle installation on its [separate deployment runner](ORACLE-RELEASE.md). The generic CLI below is experimental, not a verified replacement for that runner.

Read the target release notes and [data compatibility](DATA-MIGRATIONS.md#현재-버전) before updating. Finish active generation and edits. Download the app's consistent SQLite snapshot, record the running app/image version, and preserve external Codex login files separately. Stop the server before switching code or restoring data. Do not use `reset:dev` or `docker compose down -v` to update an existing workspace.

From a clean source checkout, with the existing server stopped:

```sh
git fetch origin --tags
git switch --detach v0.1.1
npm ci
npm run dev
```

A source archive without Git can instead be extracted into a separate directory; keep the previous installation and start the new one with the same explicit `UIMORI_DB` path only after stopping the previous server. Preserve any other installation environment and external runtime configuration. `npm start` alone does not rebuild an old installation. Confirm **Settings → App information** shows the expected app version, then open an existing chat and verify saving and reopening it. These steps do not call a model unless you request generation.

To recover, stop the new server, retain its data for inspection, and restore the **previous application/image together with its pre-update DB snapshot**. Start from a separate restored DB path/volume, or move the stopped DB and its `-wal`/`-shm` sidecars aside before replacing it; never combine a snapshot with unrelated WAL files. DB downgrade is not supported. Work saved after the snapshot is not included in that recovery point. See [backup scope](DATA-MIGRATIONS.md#복구와-자료-교환).

The Oracle runner's `--source-ref` currently accepts a branch, not a release tag. For this release, deploy the verified `main` commit matching `v0.1.1`; do not pass the tag as a branch. Tag creation and GitHub release publication never deploy the running service.

## Maintenance mode

`GET /api/maintenance` returns the current status, epoch, and `activeWork`. `POST /api/maintenance` accepts `{status:"closed"|"open", reason?:string}`. The setting persists across restarts and is controlled by the operator API.

Closing maintenance blocks new writes and worker claims. In-progress work can finish and save its results; reads, login, diagnostics, cancellation, and skipping remain available. Rejected writes return `503 MAINTENANCE_CLOSED`, and the browser retains its drafts.

`UIMORI_MAINTENANCE=1` starts the app with DB admission/migration and reads, but without task recovery or workers. It is not a read-only SQLite open; validate a copy, not the only original DB. This boot mode cannot be reopened through the API. The implementation is in [maintenance.ts](../server/maintenance.ts) and [app.ts](../server/app.ts).

## Operator CLI

Run the CLI on the Docker host with Node and Docker Compose available. Copy [update.example.json](../deploy/update.example.json) to `.local/update.json` and configure:

| Field | Meaning |
| --- | --- |
| `composeFile`, `envFile` | Paths to this installation's Compose and environment files. |
| `releaseRoot` | Journal and backup directory outside the Compose project directory. |
| `dataVolume` | The currently active data volume; update this setting after a successful volume switch. |
| `image` | A local Docker image reference with a digest or tag. The controller inspects it; it does not pull or build it. `--image` overrides this field. |
| `appOrigin` | Exact HTTPS origin, or HTTP at `127.0.0.1`, without a trailing slash. |
| `appService`, `drainTimeoutMs` | Optional; default to `app` and 30 minutes. |

Set `UIMORI_ACCESS_TOKEN` in the operator environment before `start`. Request keys contain 8–100 letters, digits, underscores, dots, or hyphens.

```sh
npm run update -- start --config .local/update.json \
  --image ghcr.io/team/uimori@sha256:... --key update-2026-09-19
npm run update -- status --config .local/update.json
npm run update -- cancel --config .local/update.json --key update-2026-09-19
```

`start` runs in the foreground. `status` reads `releaseRoot/update-journal.json`; `cancel` records a cancellation request for the running controller. These two commands do not require the access token. A matching completed journal returns its stored result, and a different key cannot replace a running update.

## Transition and recovery

Empty and personal-v1 databases are supported. Opening a supported earlier personal-workspace DB upgrades it transactionally to the current schema; preserve its backup before starting the candidate. The supported versions are listed only in [data formats](DATA-MIGRATIONS.md#현재-버전). Other legacy formats still require the separate schema-24-to-personal-v1 transfer tool and a verified new database. The controller does not infer or reset unrelated formats. See [data formats](DATA-MIGRATIONS.md).

The controller prepares the image, closes maintenance, waits for `activeWork` to reach zero, and stops the app. It archives the entire data volume, restores it into a new volume, and starts the candidate with `UIMORI_MAINTENANCE=1`. The candidate command checks for the app's ready event. It then changes `UIMORI_IMAGE` and `UIMORI_DATA_VOLUME` in the environment file, starts the Compose app service, checks `/api/session`, and reopens maintenance. Other environment settings, the previous volume, and the backup remain in place.

Before the `switch` stage completes, a failure or cancellation attempts to restore the previous environment and service and reopen maintenance. After `switch` completes, automatic rollback and cancellation are disabled, including if reopening maintenance fails. Inspect the journal's stage, error, and rollback result when recovery is needed; the journal records the attempted operation rather than proving the live Docker state.

The CLI and transition logic are in [uimori-update.mjs](../scripts/uimori-update.mjs) and [update-controller.mjs](../scripts/update-controller.mjs). [Controller tests](../scripts/update-controller.test.mjs) exercise the decision logic with injected Docker and HTTP effects; [maintenance tests](../tests/maintenance.test.ts) cover the app gate. These tests do not establish real image, volume, or container behavior.
