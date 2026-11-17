# mushnote

collaborative markdown notes on disk, real-time multi-user editing, and a built-in gemini agent that can read and edit your vault.

self-host for a **small group** — a couple, roommates, close friends — on one machine. not a thousand-user saas.

## use cases

| | |
|--|--|
| ![home](resources/icons/general/home.png) **shared household notes** | one vault for todos, grocery lists, trip plans, and the random stuff you both need to find later |
| ![bot](resources/icons/general/bot.png) **a household agent** | chat that can search, edit, and remember; personal memory lives in each user's `personality.md` |
| ![web](resources/icons/general/web.png) **research into the vault** | web search and page reads that land as markdown notes, with sources you can keep |
| ![media](resources/icons/general/media.png) **media in the same place** | drop images, pdfs, audio, video, and youtube downloads next to the notes that mention them |
| ![code](resources/icons/files/code.png) **project notes on disk** | code files, configs, and markdown side by side; the agent can read, edit, clone repos, and call apis |
| ![thought](resources/icons/general/thought.png) **ask about what you selected** | highlight text or drag a file into chat for a grounded answer without leaving the editor |

## screenshots

![mushnote editor](resources/productshot.png)

## features

**notes**
- vault is plain files (`.md`, code, json, etc.) under `vault/`
- wysiwyg editor with tabs, tasks, tables, math, images, `==highlights==`, note links
- file history with diffs in `history/` (hourly groups or every save, restore from the toolbar)
- deleted note tracker for files that left the vault (moves and renames still tracked)
- multi-user sync over websockets

**ai assistant**
- chat sidebar with streaming replies and tool badges
- vault tools for search, text read/edit/create, media analyze, move/copy/delete, history
- download files or public git repos into the vault; extract zip/jar/7z/rar; call http apis
- chat file uploads land in `media/chat-uploads/` as vault path refs (agent can analyze or link them into notes)
- personal memory lives in `system/<userid>/personality.md` (agent edits it like any other note)
- scheduled jobs as yaml under `system/<userid>/jobs/`
- optional web: google serp search (organic + ai overview), read public pages as markdown, youtube info/transcript/download
- context: open tabs, active note, weather, location, user memory

**accounts**
- users in `vault/system/config.yaml` (passwords hashed on save)
- admins can reach `system/` config and preferences

**external api (v1)**
- register a dedicated user (`POST /api/v1/auth/register` with admin token or `registration_secret`)
- login → bearer token → list, read, put, patch notes under the vault
- see [docs/api-v1.md](docs/api-v1.md)

## agent tools

| icon | tool | what it does |
|------|------|--------------|
| ![file_search](resources/icons/tools/tool-file-search.png) | `file_search` | search vault text by content/title/path, or media by filename/folder/`media_kind`/size; `recent=true` lists recently modified files |
| ![web_search](resources/icons/tools/tool-web-search.png) | `web_search` | bright data google serp (ai overview when present); `news=true` for google news |
| ![web_read_page](resources/icons/tools/tool-web-read-page.png) | `web_read_page` | fetch one https url to markdown/text |
| ![youtube_video](resources/icons/tools/tool-youtube-video.png) | `youtube_video` | youtube `info`, `transcript`, or `download` (audio/video) via yt-dlp |
| ![download](resources/icons/tools/tool-download.png) | `download` | save an http(s) file into the vault, or shallow-clone a public git repo |
| ![api_request](resources/icons/tools/tool-api-request.png) | `api_request` | http GET/POST/PUT/PATCH/DELETE for json or form apis; optional save response to vault |
| ![archive_extract](resources/icons/tools/tool-archive-extract.png) | `archive_extract` | unpack a vault `.zip`, `.jar`, `.7z`, or `.rar` into a folder next to it |
| ![textfile_read](resources/icons/tools/tool-textfile-read.png) | `textfile_read` | read a text/code file; optional heading or line slice; `mode=outline` for headings only |
| ![file_analyze](resources/icons/tools/tool-file-analyze.png) | `file_analyze` | load image/pdf/audio/video into gemini, or `mode=metadata` for size/dates/type |
| ![file_open_for_user](resources/icons/tools/tool-file-open-for-user.png) | `file_open_for_user` | open a vault file in an editor tab for the user |
| ![textfile_create](resources/icons/tools/tool-textfile-create.png) | `textfile_create` | create a new text file |
| ![textfile_edit_diff](resources/icons/tools/tool-textfile-edit-diff.png) | `textfile_edit_diff` | targeted edits (replace, insert, delete, append; batchable) |
| ![textfile_history](resources/icons/tools/tool-textfile-history.png) | `textfile_history` | browse edit history: hourly → chunk → revision snapshot |
| ![file_move](resources/icons/tools/tool-file-move.png) | `file_move` | rename or move a file or folder |
| ![file_copy](resources/icons/tools/tool-file-copy.png) | `file_copy` | copy a file or folder |
| ![file_delete](resources/icons/tools/tool-file-delete.png) | `file_delete` | permanently delete a file |
| ![folder_delete](resources/icons/tools/tool-folder-delete.png) | `folder_delete` | permanently delete a folder and its contents |

## why this stack

**gemini 3.5 flash lite** (`backend/agent/`)  
the agent runs a lot of turns: chat, tool calls, big file snippets, history compression. flash lite is built for **high volume at low cost** and still fast enough for day-to-day help. for a few people sharing notes, that matters more than the heaviest reasoning model.

**bright data** (optional `web_search` and `web_read_page`)  
home-grown scraping of google or random sites means captchas, blocked ips, and brittle html. bright data’s serp api returns **structured google results** (and overview when available); the webview zone fetches pages as markdown. mushnote hardcodes **google full json serp + ai overview** so config stays small.

**on disk, not in a proprietary cloud**  
notes live in `vault/`. you get collaboration and an agent without locking content in someone else’s notebook product.

## cost (can stay free)

prices checked **2026-11-15**. vendors change these — verify on the linked pages before you budget.

| piece | free tier (what i use) | paid rate if you outgrow free | mushnote note |
|-------|------------------------|-------------------------------|---------------|
| **gemini 3.5 flash lite** ([pricing](https://ai.google.dev/gemini-api/docs/pricing)) | free input and output on the free tier in [ai studio](https://aistudio.google.com/) | **$0.30 / 1M** input, **$2.50 / 1M** output | default agent model; high-volume chat + tools |
| **bright data serp** ([serp api](https://brightdata.com/products/serp-api)) | **5K records / month**, no card required to start | paid plans after free allotment | about one record per `web_search`; page reads use the webview zone |
| **youtube / yt-dlp + ffmpeg** | bundled via npm (`youtube-dl-exec`, `ffmpeg-static`) | — | no youtube data api key |
| **mushnote itself** | **$0** (mit) | — | host on your pc or a small vps |

**what i actually pay right now:** **$0 / month** — gemini free tier for the agent, bright data’s free serp allotment for occasional search, and local yt-dlp/ffmpeg for downloads. a couple of light daily users fits that envelope. if you blow past free quotas, flash lite paid rates above are still cheap compared with bigger models.

without bright data keys, everything else still works — web tools return “not configured.”

## requirements

- **node.js 20+** (developed on node 24; 20 or 22 lts is fine)
- **os:** windows, macos, or linux
- **disk:** a writable `vault/` and `history/` path (defaults next to the repo)

**youtube helpers (optional):**
- `npm --prefix backend install` pulls **yt-dlp** through `youtube-dl-exec` and **ffmpeg** through `ffmpeg-static`
- on **windows**, the postinstall drops `yt-dlp.exe` and an ffmpeg binary under `backend/node_modules` — no system path setup needed for the usual case
- on **linux/macos**, the same packages download platform binaries; if a download is blocked in your environment, install `yt-dlp` and `ffmpeg` via your package manager and ensure they are on `PATH`, or re-run install with network access so `ffmpeg-static` can fetch its binary
- merged mp4 / mp3 conversion needs ffmpeg present (the static package path is preferred when found)

## setup

```bash
npm --prefix backend install
npm --prefix backend rebuild
```

> [!NOTE]
> On newer versions of npm (v12+ / Node 26), lifecycle scripts may be blocked by default. Running `npm --prefix backend rebuild` (or `npm install --ignore-scripts=false`) ensures native binaries like `ffmpeg` and `yt-dlp` download properly.

config lives at `vault/system/config.yaml` (copied from `resources/config.example.yaml` on first boot if missing).

### 1. gemini (required)

1. open [google ai studio](https://aistudio.google.com/) and create an api key.
2. in `vault/system/config.yaml`:

```yaml
gemini:
  api_key: "your-key"
  ai-username: ai
```

3. add human users under `users:` (see example). first admin can manage accounts in-app.

### 2. bright data (optional web)

sign up at [bright data](https://brightdata.com/) to grant the agent live google search and web page reading abilities.

in your bright data control panel, create two zones:
1. **serp zone** (for `web_search`)
   - type: **serp api**
   - format: **google full json**
   - name: e.g. `mushnote_serp`
2. **webview zone** (for `web_read_page`)
   - type: **scraping browser** or **web unlocker**
   - name: e.g. `mushnote_webview`

copy your api key from settings, and add both to `vault/system/config.yaml`:

```yaml
brightdata:
  api_key: "your-bright-data-api-key"
  serp_zone: mushnote_serp
  webview_zone: mushnote_webview
  country: us
```

restart the server to activate web tools. without bright data, the agent continues operating normally on vault notes.

### 3. youtube (optional, no extra api)

`npm install` in `backend` pulls **yt-dlp** via `youtube-dl-exec` (postinstall downloads `yt-dlp.exe` on windows) and **ffmpeg** via `ffmpeg-static` (platform binary in node_modules, used for mp3 and merged video).

the `youtube_video` tool supports `info`, `transcript`, or `download` (audio mp3 by default, video muxed webm when `media: video`; merged mp4 if `format: mp4`). works when youtube exposes captions and the video is public. no google youtube api billing.

### 4. run

```bash
npm --prefix backend start
```

dev with auto-restart:

```bash
npm --prefix backend run dev
```

open [http://localhost:3000](http://localhost:3000) on your lan so others can join (set `server.host` if you need to bind beyond localhost).

### 5. running as a linux service (systemd)

to run mushnote as a background daemon on linux that launches on boot:

1. create `/etc/systemd/system/mushnote.service`:

```ini
[Unit]
Description=Mushnote Service
After=network.target

[Service]
Type=simple
User=youruser
Group=youruser
WorkingDirectory=/home/youruser/mushnote/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# security hardening
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/home/youruser/mushnote

[Install]
WantedBy=multi-user.target
```

2. enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mushnote
```

3. check logs:

```bash
journalctl -u mushnote -f
```

if using a reverse proxy like **caddy**, set `host: 127.0.0.1` in `vault/system/config.yaml` and proxy in your `Caddyfile`:

```caddyfile
notes.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

## jobs setup

scheduled agent runs live as yaml files under `system/<userid>/jobs/`. filename (without `.yaml`) is the job name. each run opens a saved chat titled `JOB: <name>, <time>` (also the error log).

fields:
- `time` — daily local time (`HH:MM` 24h, or `7:00am`)
- `prompt` — what the agent should do when it fires

sample `system/wyatt/jobs/morning-brief.yaml`:

```yaml
time: "07:00"
prompt: |
  check todo.md and summarize what needs attention today
  if the weather looks rough, mention it briefly
```

create or edit jobs in the vault (or ask the agent to write them with `textfile_create` / `textfile_edit_diff`). the server watches the jobs folder and runs due jobs on its ticker.

## layout

| path | purpose |
|------|---------|
| `backend/` | express entry (`server.js`) |
| `backend/core/` | config, logger, auth |
| `backend/http/` | external api v1 routes |
| `backend/agent/` | gemini agent, tools, jobs |
| `backend/agent/chat/` | history compression, cite sanitize, titles |
| `backend/sync/` | yjs sync + markdown schema |
| `backend/vault/` | files, watcher, history, conversations |
| `backend/integrations/` | bright data, youtube, weather, ffmpeg |
| `frontend/` | editor ui (`index.html` login, `editor.html` workspace) |
| `frontend/css/` | split stylesheets (login loads a smaller set) |
| `frontend/js/core/` | boot, api, state |
| `frontend/js/workspace/` | files tree, tabs, layout, login, preview |
| `frontend/js/chat/` | assistant sidebar |
| `frontend/js/editor/` | note open/close, selection, dragdrop |
| `frontend/js/editor/rich/` | tiptap markdown editor + mermaid/math bundle |
| `frontend/js/editor/plain/` | codemirror for code files |
| `frontend/js/editor/collab/` | yjs sync, cursors, flash |
| `frontend/js/editor/media/` | images and media viewer helpers |
| `frontend/js/editor/history/` | history viewer and revision preview |
| `vault/` | notes and `system/config.yaml` |
| `history/` | version database |
| `resources/` | example config, default avatars, ui and tool icons, product shot |
| `docs/` | external api notes |

## license

[mit](LICENSE) — free to use, copy, modify, and ship. keep the copyright notice.
