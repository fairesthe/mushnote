# mushnote

collaborative markdown notes on disk, real-time multi-user editing, and a built-in gemini agent that can read and edit your vault.

i built mushnote for **me and my girlfriend** — shared notes, todos, and a cat-shaped agent in one place we both actually use. it is aimed at a **small group** (a couple, roommates, close friends) self-hosting on one machine, not a thousand-user saas.

## features --------------------

**notes**
- vault is plain files (`.md`, code, json, etc.) under `vault/`
- wysiwyg editor with tabs, tasks, math, images, `==highlights==`, note links
- file history with diffs in `history/`
- multi-user sync over websockets

**ai assistant**
- chat sidebar with streaming replies
- vault tools: search, open, edit, create, move, media analysis
- optional web: google serp search (organic results + ai overview when google shows it), read public pages as markdown
- context: open tabs, active note, weather, location

**accounts**
- users in `vault/system/config.yaml` (passwords hashed on save)
- admins can reach `system/` config and preferences

**external api (v1)**
- register a dedicated user (`POST /api/v1/auth/register` with admin token or `registration_secret`)
- login → bearer token → list, read, put, patch notes under the vault
- see [docs/api-v1.md](docs/api-v1.md)

## why this stack --------------------

**gemini 3.5 flash lite** (`backend/agent.js`)  
the agent runs a lot of turns: chat, tool calls, big file snippets, history compression. flash lite is built for **high volume at low cost** and still fast enough for day-to-day help. for a few people sharing notes, that matters more than the heaviest reasoning model.

**bright data** (optional `web_search` and `web_read_page`)  
home-grown scraping of google or random sites means captchas, blocked ips, and brittle html. bright data’s serp api returns **structured google results** (and overview when available); the webview zone fetches pages as markdown. mushnote hardcodes **google full json serp + ai overview** so config stays small.

**on disk, not in a proprietary cloud**  
notes live in `vault/`. you get collaboration and an agent without locking content in someone else’s notebook product.

## cost (can stay free) --------------------

| piece | typical free tier | mushnote use |
|-------|-------------------|--------------|
| **google ai studio** | monthly api credits (often described as on the order of **~$10/mo** worth for dev testing — check current [ai studio](https://aistudio.google.com/) billing) | agent chat and tools for a **few active users** usually fits casual use |
| **bright data** | **5,000 serp credits/month** on new accounts ([serp api](https://brightdata.com/products/serp-api)) | roughly one credit per search; page reads use the webview zone (see their pricing) |

no license fee for mushnote itself. you pay only for api usage you actually burn. vault hosting is your pc or a small vps.

without bright data keys, everything else still works — web tools return “not configured.”

## setup --------------------

```bash
npm --prefix backend install
```

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

1. sign up at [bright data](https://brightdata.com/).
2. create two zones in the control panel:
   - **serp zone** — data format **google full json** (name it e.g. `mushnote_serp`)
   - **webview zone** — web unlocker or scrape for page fetch (e.g. `mushnote_webview`)
3. same api key is used for both; paste into config:

```yaml
brightdata:
  api_key: "your-bright-data-api-key"
  serp_zone: mushnote_serp
  webview_zone: mushnote_webview
  country: us
```

4. restart the server. try a chat web search to confirm.

without bright data the agent still edits notes and answers from the vault.

### 3. youtube (optional, no extra api)

`npm install` in `backend` pulls **yt-dlp** via `youtube-dl-exec` (postinstall downloads `yt-dlp.exe` on windows) and **ffmpeg** via `ffmpeg-static` (platform binary in node_modules, used for mp3 and merged video). agent tools:

- **youtube_video** — `info`, `transcript`, or `download` (audio mp3 by default, video muxed webm when `media: video`; merged mp4 if `format: mp4`)

works when youtube exposes captions and the video is public. no google youtube api billing.

### 4. run

```bash
npm --prefix backend start
```

dev with auto-restart:

```bash
npm --prefix backend run dev
```

open [http://localhost:3000](http://localhost:3000) on your lan so others can join (set `server.host` if you need to bind beyond localhost).

## layout --------------------

| path | purpose |
|------|---------|
| `backend/` | express server, sync, agent, bright data client |
| `frontend/` | editor ui |
| `vault/` | notes and `system/config.yaml` |
| `history/` | version database |
| `resources/` | example config and default avatars |
