# Linux/Docker updates

Uimori has a persistent maintenance mode and an operator CLI for updating a Compose installation. The in-app Update button and release catalog integration are not implemented. The controller's Docker workflow has not yet been verified on a real Docker host. For installation, see [SELF-HOST](SELF-HOST.md); the separate Oracle deployment tool is documented in [ORACLE-RELEASE](ORACLE-RELEASE.md).

## Maintenance mode

`GET /api/maintenance` returns the current status, epoch, and `activeWork`. `POST /api/maintenance` accepts `{status:"closed"|"open", reason?:string}`. The setting persists across restarts and is also available from the app's backup settings.

Closing maintenance blocks new writes and worker claims. In-progress work can finish and save its results; reads, login, diagnostics, cancellation, and skipping remain available. Rejected writes return `503 MAINTENANCE_CLOSED`, and the browser retains its drafts.

`UIMORI_MAINTENANCE=1` starts the app for current-schema admission and reads without recovery or workers. This boot mode cannot be reopened through the API. The implementation is in [maintenance.ts](../server/maintenance.ts) and [app.ts](../server/app.ts).

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

Only empty or current schema-23 databases are supported. The controller does not upgrade old data: a copied older database fails candidate admission before writes. Preserve its volume and backups; beginning with the new native structure requires a separate empty volume, outside an in-place update. See [data formats](DATA-MIGRATIONS.md).

The controller prepares the image, closes maintenance, waits for `activeWork` to reach zero, and stops the app. It archives the entire data volume, restores it into a new volume, and starts the candidate with `UIMORI_MAINTENANCE=1`. The candidate command checks for the app's ready event. It then changes `UIMORI_IMAGE` and `UIMORI_DATA_VOLUME` in the environment file, starts the Compose app service, checks `/api/session`, and reopens maintenance. Other environment settings, the previous volume, and the backup remain in place.

Before the `switch` stage completes, a failure or cancellation attempts to restore the previous environment and service and reopen maintenance. After `switch` completes, automatic rollback and cancellation are disabled, including if reopening maintenance fails. Inspect the journal's stage, error, and rollback result when recovery is needed; the journal records the attempted operation rather than proving the live Docker state.

The CLI and transition logic are in [uimori-update.mjs](../scripts/uimori-update.mjs) and [update-controller.mjs](../scripts/update-controller.mjs). [Controller tests](../scripts/update-controller.test.mjs) exercise the decision logic with injected Docker and HTTP effects; [maintenance tests](../tests/maintenance.test.ts) cover the app gate. These tests do not establish real image, volume, or container behavior.
