# Uimori

**English** · [한국어](README.ko.md)

Uimori is a personal creative-writing web app for reading long manuscripts and continuing them scene by scene. Run it on your own PC, or host it on a personal server and use the same workspace from your PC and phone.

- Organize chats and folders per bot, and use original Risu bots, personas and modules.
- Configure prompts and models separately.
- Edit source text and translations directly, and copy a chat into an independent copy.
- Keep story memory and backups.

> **Current version `v0.12.18` · DB schema 15**
>
> This release simplifies app guidance and improves notices and controls on narrow screens. See the [release notes](docs/releases/v0.12.18.md) for details and the [update guide](docs/UPDATES.md) for updating an existing installation.

> [!NOTE]
> The detailed guides under `docs/` are written in Korean. The app interface itself supports English.

## Quick start (Windows)

**Requirements**: Node **24.22.1 or later 24.x**, npm, and Chrome or Edge. SQLite comes built into Node, so no separate install is needed.

1. Check that the `v0.12.18` release is published on [GitHub Releases](https://github.com/woduseh/Uimori/releases).
2. Get the source and start the app.

   ```powershell
   git clone --branch v0.12.18 --single-branch https://github.com/woduseh/Uimori.git
   cd Uimori
   npm ci
   npm run dev
   ```

3. Open the [local app](http://127.0.0.1:4310) in your browser.

Notes:

- If you already have the source, start with `npm ci` in the project root.
- `npm run dev` builds and then starts the server. If it is already built, `npm start` starts it directly.
- If a previous server is still running, stop it with Ctrl+C in its terminal before starting again.

### First steps

1. **Create a chat**: In **Library → Bot**, create or choose a bot and select **New chat as bot**. You can also pick a bot in the left navigation and select **New chat**.
   - A bot is required, and a chat's bot cannot be changed after creation.
   - Persona, prompt and creative preset are optional.
2. **Add models**: In **Settings → Providers and models**, register a provider and models, then assign them to global roles. Enter API keys directly in the app.
   - You can create chats or use a written opening without a model. Roles that run a model, such as text generation and translation, need one.
3. **Request a scene**: Send a scene request from the input box at the bottom. The default send key is Ctrl/Cmd+Enter.
4. **Translate**: Select **Generate translation** on a manuscript to start translating. Open saved translations with **View translation**, and request failed ones again with **Retry translation**.
   - Switching views of a saved translation and saving source or translation edits do not call a model.

> **JEV (optional)**: Choosing **TypeSafe AI** when adding a provider registers **JEV** in the model list. JEV handles refusal checks for text and translations and lore relevance; existing image placement uses either the writing model or JEV. Only features that use JEV need its key, and text refusal detection is off by default.

Choose the interface language in **Settings → General → Interface language**: Korean, English, Japanese or Simplified Chinese. The choice is stored in the browser and does not change manuscripts, saved translations, or the target language of generation and translation. See [language settings and scope](docs/I18N.md).

### Run agents with a ChatGPT subscription (optional)

To run agents with a personal ChatGPT subscription, prepare the server runner by following the [Codex connection guide](docs/CODEX.md), then sign in from **Settings → Codex connection**.

## Personal Linux server

The [self-hosting guide](docs/SELF-HOST.md) covers Docker Compose and an Nginx HTTPS setup. With a domain, certificate and access token configured, you can reach the same workspace from your PC and phone. The SQLite database is stored in a persistent volume.

## Versions and updates

- **Settings → About** shows the server's app version and build identifier. The app version is the release number and is separate from the DB schema number.
- There are no update notifications, in-app installs or unattended automatic updates.
- Update an existing installation with the [manual update](docs/UPDATES.md#수동-릴리스-업데이트) procedure. The running Oracle installation uses its [dedicated deployment guide](docs/ORACLE-RELEASE.md).
- Creating a tag or GitHub Release does not update any server by itself.

## Documentation (Korean)

### Using the app

| Guide | Covers |
| --- | --- |
| [Usage](docs/USAGE.md) | Per-bot chats and folders, settings search, prompts and creative presets, translation, independent chat copies, backups |
| [Outline workspace](docs/OUTLINE.md) | Hierarchical outlines, linked plans, writing selected units and reviewing the manuscript |
| [Story guide](docs/STORY-GUIDE.md) | Optional writing reference, asking the helper about the original work, notes and corrections |
| [Library and prompts](docs/LIBRARY.md) · [Deleting items](docs/DELETION.md) | Organizing resources, folders and cover images; where deletion happens and reference protection |
| [Risu import](docs/RISU-IMPORT.md) | Original `.charx` cards, modules and `.risup` prompts; CBS, Lua, regex and CSS execution and supported scope |
| [Risu export](docs/RISU-EXPORT.md) | Exporting saved cards, modules and prompts as CHARX, RISUM and RISUP |
| [Reading position and bookmarks](docs/READING-STATE.md) | Per-device resume reading, bookmarks and personal backups |
| [Manuscript search](docs/MANUSCRIPT-SEARCH.md) | Searching source text, translations and requests, and jumping to scenes |
| [Scene illustrations](docs/ILLUSTRATIONS.md) | Per-response illustrations via Codex image generation or remote ComfyUI; automatic generation, retries and count limits |
| [Helper tools](docs/HELPER-TOOLS.md) · [Codex connection](docs/CODEX.md) | Partial reads and edits, settings and task control, native execution |
| [Workspace usage](docs/USAGE-REPORT.md) | Calls, tokens and reported/estimated costs by day, model and purpose |
| [App install and notifications](docs/PWA.md) | PWA install, a service worker without manuscript caching, explicit per-device Web Push |

### Setup and operations

| Guide | Covers |
| --- | --- |
| [Providers](docs/PROVIDERS.md) | Vertex and Google AI Studio Gemini, Responses/Chat-compatible APIs, Anthropic realtime and Batch, Vercel, Codex providers, optional evaluation tools and synthetic tests |
| [Self-hosting](docs/SELF-HOST.md) | Docker Compose, HTTPS, sign-in, persistent data, model API keys and updates |
| [Automatic backups](docs/AUTOMATIC-BACKUPS.md) | Daily snapshots on Korea time, verification, retention and download |
| [Diagnostics and run details](docs/DIAGNOSTICS.md) | Checking task status, errors, retained run inputs and recovery behavior |
| [Oracle release](docs/ORACLE-RELEASE.md) | Verification and deployment commands, data preservation and failure recovery |

### Development

| Guide | Covers |
| --- | --- |
| [Development and verification](docs/DEVELOPMENT.md) | Check and cleanup commands, isolated runs, code structure and evidence retention |
| [Code map](docs/CODE-MAP.md) | Current documents and implementation entry points by feature |

## Data and access

**Database and backups**

- The default database is `.local/uimori.sqlite`.
- Uimori opens only empty databases and databases in the [current data format](docs/DATA-MIGRATIONS.md#현재-버전); older databases are rejected without changes. Keep old backups together with the app version that created them.
- Save a SQLite backup from **Settings → Data management → Backup and restore**. Individual resources and chats can be imported as new copies. [Backups and isolated databases](docs/USAGE.md)
- To reset a disposable development database, stop the server and run `npm run reset:dev`.

**Access**

- The default is local mode on `127.0.0.1`; you can enable authentication with `UIMORI_ACCESS_TOKEN`.
- Personal server mode requires a single HTTPS address in `UIMORI_PUBLIC_ORIGIN` and an access token of at least 32 characters.
- `UIMORI_HOST` sets the listen address. External listening is allowed only in personal server mode. [Access requirements](docs/SELF-HOST.md#프록시와-접속-조건)

**API keys**

- Provider API keys and the JEV key are entered in the app and stored in the database.
- A full SQLite backup includes keys and images. User databases and run artifacts are excluded from Git.

## License

- Uimori's project source is provided under [AGPL-3.0-only](LICENSE).
- See the [third-party notices](THIRD_PARTY_NOTICES.md) for the original terms and copyrights of third-party components, including RPack.
- Rights to your own resources, chats and generated output follow their respective terms; the app's source license does not apply to them automatically.
- When serving the app to others or distributing a modified version, follow the [corresponding-source guide for the running build](docs/SELF-HOST.md#라이선스와-대응-소스).
