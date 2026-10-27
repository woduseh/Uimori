# Linux/Docker updates

Source and Compose installations use manual updates. The existing Oracle installation uses its [dedicated deployment runner](ORACLE-RELEASE.md), which owns maintenance, backups, candidate verification and recovery. For installation, see [SELF-HOST](SELF-HOST.md).

## Manual release update

Use this path for source installations; see [SELF-HOST](SELF-HOST.md#저장과-운영) for manual Compose operations. Keep the existing Oracle installation on its [dedicated deployment runner](ORACLE-RELEASE.md).

Read the target release notes and [data compatibility](DATA-MIGRATIONS.md#현재-버전) before updating. Finish active generation and edits. Download the app's consistent SQLite snapshot, record the running app/image version, and preserve external Codex login files separately. Stop the server before switching code or restoring data. Do not use `reset:dev` or `docker compose down -v` to update an existing workspace.

**v0.11.25 keeps SQLite schema 15**, used by releases since v0.4.0. A compatible schema-15 workspace can update in place after the normal backup. There is no direct conversion from older databases, including schema 12 from v0.3.1. Keep those files with their matching application version; do not edit the schema number or substitute an empty database to bypass a compatibility error.

The current release refines multilingual UI copy and removes redundant guidance without changing saved manuscripts. Verify the affected settings, helper and chat flows after updating; see the [v0.11.25 notes](releases/v0.11.25.md) for details.

When updating from before v0.11.1, startup preserves an independent old prompt body as a library preset before changing the current prompt to a preset reference. New requests use the selected source and explicit option overrides. Keep the pre-update backup for rollback, and review the [v0.11.1 notes](releases/v0.11.1.md) for retired APIs and evaluation settings. Existing helper conversation personas, manuscripts and historical execution records remain readable.

Finish queued or running evaluation Batch work under its original runtime before updating. Both retained evaluation modes now require a valid final submission, and the retired `source-bound` mode is disabled for new execution. The new runtime does not emulate the previous evaluation protocol.

Use the published `v0.11.25` tag for a reproducible source installation. Updating the source or publishing a GitHub release never updates an already running server.

From a clean source checkout, with the existing server stopped:

```sh
git fetch origin --tags
git switch --detach v0.11.25
npm ci
npm run dev
```

A source archive without Git can instead be extracted into a separate directory; keep the previous installation and start the new one with the same explicit `UIMORI_DB` path only after stopping the previous server. Preserve any other installation environment and external runtime configuration. `npm start` alone does not rebuild an old installation. Confirm **Settings → App information** shows the expected app version, then open an existing chat and verify saving and reopening it. These steps do not call a model unless you request generation.

For Compose, keep the existing environment settings and named data, backup and helper-workspace volumes. The data volume also contains the app's external Codex login files. After saving a consistent backup and finishing active work, stop the app and shell-runner services before replacing their image, then recreate both with the same image. Reuse the data volume only when the release supports that database format. Check the app health and the same save/reopen flow before continuing work. Manual Compose commands do not automatically create a backup or roll back a failed update.

To recover, stop the new server, retain its data for inspection, and restore the **previous application/image together with its pre-update DB snapshot**. Start from a separate restored DB path/volume, or move the stopped DB and its `-wal`/`-shm` sidecars aside before replacing it; never combine a snapshot with unrelated WAL files. DB downgrade is not supported. Work saved after the snapshot is not included in that recovery point. See [backup scope](DATA-MIGRATIONS.md#복구와-자료-교환).

The Oracle runner's `--source-ref` currently accepts a branch, not a release tag. For a tagged release, deploy from a verified release branch pointing at the tag's exact commit, rather than assuming the advancing `main` still matches the tag. Verify the source SHA and GitHub Quality CI for that same commit before deployment. Do not pass a tag as a branch. Tag creation and GitHub release publication never deploy the running service.

## Maintenance mode

`GET /api/maintenance` returns the current status, epoch, and `activeWork`. `POST /api/maintenance` accepts `{status:"closed"|"open", reason?:string}`. The setting persists across restarts and is controlled by the operator API.

Closing maintenance blocks new writes and worker claims. In-progress work can finish and save its results; reads, login, diagnostics, cancellation, and skipping remain available. Rejected writes return `503 MAINTENANCE_CLOSED`, and the browser retains its drafts.

`UIMORI_MAINTENANCE=1` starts the app with DB admission and reads, but without task recovery or workers. It is not a read-only SQLite open; validate a copy, not the only original DB. This boot mode cannot be reopened through the API. The implementation is in [maintenance.ts](../server/maintenance.ts) and [app.ts](../server/app.ts).

The Oracle runner uses these admission and boot boundaries to wait for active work, verify a candidate database copy and reopen writes after deployment. [Maintenance tests](../tests/maintenance.test.ts) cover the app gate; the [Oracle release guide](ORACLE-RELEASE.md) describes the separate image, backup and recovery checks.
