# Mushnote Info

Mushnote is a collaborative, local-first markdown workspace with real-time multi-user editing and a built-in Gemini AI assistant.

## UI & Workspace Layout
- **Left Sidebar (Files):** Browse folders and files in `vault/`, create/rename/move/delete notes, and drag files into the editor or AI chat.
- **Basic UI Tasks:**
  - **Create a new note or folder:** Click the `...` (more) button in the files sidebar quick bar (or right-click anywhere in the files list) and choose **new note** or **new folder**, or ask the AI to create one.
  - **Open, rename, move, copy, or delete:** Click a note to open it in the current tab, or right-click any file/folder (or use its `...` menu) for **open in new tab**, **rename**, **move**, **copy**, **download**, or **delete**.
  - **View edit history:** Use the history button in the editor toolbar to browse hourly snapshots and restore revisions.
- **Center Editor:** WYSIWYG markdown and code editor supporting tasks, GFM tables, `==highlights==`, LaTeX math (`$...$` / `$$...$$`), images, note links (`[label](path.md)` or `[[path]]`), and per-file edit history.
- **Right Drawer (AI Assistant):** Streaming chat with tool badges, file/selection attachments, and live edits to vault notes.
- **Synced Columns:** Both the left files sidebar and right AI drawer persist their open/collapsed state in `localStorage` and sync across all open Mushnote tabs.

## Desktop & Chrome Extension (`chrome-extension/`)
- On desktop, Mushnote requires the Chrome extension (`chrome-extension/`). Unauthenticated or extension-less visits to `/editor` redirect to `/` with an install prompt.
- **Browser-Native Tabs:** Each note opens at `/editor/<path>` in its own browser tab (bookmarkable and shareable across windows) inside the lowercase `"mushnote"` tab group.
- **Toolbar Icon:** Clicking the extension icon toggles/focuses Mushnote. The extension automatically remembers your Mushnote origin on first visit.
- **Background Tab Runner:** `web_search` and `web_read_page` open background tabs in the `"mushnote"` tab group using your real browser session, returning clean, token-bounded Markdown (`{ url, title, icon, truncated, content }`).

## Mobile PWA
- On mobile, Mushnote runs as a single-tab Progressive Web App at `/mobile` (no desktop extension required), with bottom navigation (`ai`, `files`, `editor`) and push notification support.

## Vault & Directory Structure
- `vault/` — All user notes, code, and media files on disk.
- `vault/system/config.yaml` — Server, Gemini, and user account configuration.
- `vault/system/<userid>/personality.md` — Per-user AI memory.
- `vault/system/<userid>/jobs/` — Scheduled daily YAML jobs.
- `history/` — Versioned file history and diffs.
- `media/chat-uploads/` — Files uploaded into AI chat.

## Key Agent Tools
- **Vault:** `file_search`, `textfile_read` (supports `!special/mushnote-info.md`), `textfile_create`, `textfile_edit_diff`, `textfile_history`, `file_analyze`, `file_move`, `file_copy`, `file_delete`.
- **Tabs & Web:** `tab_manage` (`open`, `focus`, `close` for vault notes and web URLs), `web_search`, `web_read_page`.
- **Media & Utilities:** `youtube_video` (`info`, `transcript`, `download` via system `yt-dlp`/`ffmpeg`), `download`, `api_request`, `eval_js`, `notify`, `archive_extract`.
