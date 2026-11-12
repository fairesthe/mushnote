Black (OLED) minimal note taking app

- Written in Nodejs

- Markdown file backend
- Simultaneous Multi-user live editing
- Backed up per-user-edit with fully-tracked, consistent history across devices
- PWA for mobile: opens to ai agent for quick opening/adding to notes / general assistant
- Offline saving/editing of note-base (service worker) (merges edits when online)

This is just for me and my girlfriend. but I would still like to setup accounts.
Each account has 
- Full google calendar integration: each event has an optionally attached note, and can create events right in the app
- Full email(s) integration using IMAP. Showing your inbox in-app and allowing linking emails in notes
- Plus general information to allow the agent to be more personal

 
- Gemini (one api key defined in config) able to search the web and the database – for use as a general agent
    - token efficent (minimal inputs and no grounding)

Using 

gemini-3.5-flash-lite

thinkingLevel: "minimal"

Dynamic system prompt


And Two Config Settings to Keep the Bill Minimal

    Minimize or disable "Thinking" tokens: Output pricing includes internal reasoning ("thinking") tokens. In your @google/genai request config, set thinkingConfig: { thinkingBudget: 0 } (or thinkingLevel: "minimal") so the model doesn't burn paid output tokens "thinking" before calling a simple tool like note_search or print_thermal.

    Pass only your custom functionDeclarations in tools: As long as you do not include googleSearch: {} or urlContext: {} in the tools array, zero grounding fees can ever be triggered.
---

### 1. Dynamic System Prompt Header (~60–90 Tokens)

Inject this live state block at the top of every request so Gemini never wastes a tool call asking for the date, checking whose account is active, or polling your inbox/schedule for today:

```text
Context:
- User: Alex | Partner: Sam | TZ: America/New_York | Now: Wed 2026-11-11 20:33
- Unread Emails: 3 (Latest: "Flight Confirmation Delta" from delta@delta.com)
- Today's Events (2): [evt_91] 18:30 Dinner w/ Sam (note_14) | [evt_92] 21:00 Call Mom
- Upcoming (48h): [evt_95] Thu 09:00 Dentist | [evt_98] Fri 19:00 Trivia Night

Rules:
- Search/query tools return compact IDs + snippets. Only call *_open or *_read when full text is needed.
- Always open a note before editing it so your diff targets exact existing text.
- Keep responses concise for mobile OLED viewing.

```

---

### 2. Organized `@google/genai` Tool Schemas (`tools.ts`)

All 14 tools are grouped by domain (`notes_*`, `web_*`, `cal_*`, `email_*`, `print_*`, `user_*`), use flat parameters (no deep nesting), and rely on short IDs (`note_42`, `evt_91`, `uid_884`).

```typescript
import { FunctionDeclaration, Type } from "@google/genai";

// ==========================================
// 1. NOTES VAULT (Markdown + CRDT/Git Backend)
// ==========================================

export const noteSearch: FunctionDeclaration = {
  name: "note_search",
  description: "Fuzzy search notes by title, tags, or content. Returns compact IDs and snippets.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Keywords or title phrase." },
      limit: { type: Type.INTEGER, description: "Max results (default 5, max 10)." },
    },
    required: ["query"],
  },
};

export const noteListRecent: FunctionDeclaration = {
  name: "note_list_recent",
  description: "List recently modified notes, optionally filtered by who edited them.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      limit: { type: Type.INTEGER, description: "Number of notes to return (default 8)." },
      author: {
        type: Type.STRING,
        enum: ["me", "partner", "all"],
        description: "Filter by last editor (default 'all').",
      },
    },
  },
};

export const noteOpen: FunctionDeclaration = {
  name: "note_open",
  description: "Read the full Markdown content and metadata of a specific note.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      note_id: { type: Type.STRING, description: "Note ID (e.g., 'note_42')." },
    },
    required: ["note_id"],
  },
};

export const noteCreate: FunctionDeclaration = {
  name: "note_create",
  description: "Create a brand new Markdown note. Do not use to edit existing notes.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Note title." },
      folder: { type: Type.STRING, description: "Optional folder path (e.g., 'Travel', 'Recipes')." },
      markdown: { type: Type.STRING, description: "Initial Markdown body." },
      tags: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Optional tags without #.",
      },
    },
    required: ["title", "markdown"],
  },
};

export const noteEditDiff: FunctionDeclaration = {
  name: "note_edit_diff",
  description:
    "Edit an existing note using exact search-and-replace blocks or append mode. Must call note_open first.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      note_id: { type: Type.STRING, description: "Target note ID." },
      mode: {
        type: Type.STRING,
        enum: ["replace", "append"],
        description: "'replace' swaps target_text with replacement_text; 'append' adds to end of file.",
      },
      target_text: {
        type: Type.STRING,
        description: "Exact existing snippet to replace (required if mode is 'replace').",
      },
      replacement_text: {
        type: Type.STRING,
        description: "New Markdown text to insert or append.",
      },
    },
    required: ["note_id", "mode", "replacement_text"],
  },
};

export const noteHistory: FunctionDeclaration = {
  name: "note_history",
  description: "View per-user edit history diffs for a note to check changes or recover text.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      note_id: { type: Type.STRING, description: "Target note ID." },
      limit: { type: Type.INTEGER, description: "Number of past revisions to show (default 5)." },
    },
    required: ["note_id"],
  },
};

// ==========================================
// 2. DEEP WEB SEARCH (DDG + DIY Playwright)
// ==========================================

export const webSearch: FunctionDeclaration = {
  name: "web_search",
  description: "Search DuckDuckGo for current info, links, and snippets.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Search query." },
      limit: { type: Type.INTEGER, description: "Number of links to return (default 5)." },
    },
    required: ["query"],
  },
};

export const webReadPage: FunctionDeclaration = {
  name: "web_read_page",
  description: "Load a URL in headless Playwright + Readability and return clean Markdown (max 8k chars).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: { type: Type.STRING, description: "Full HTTP/HTTPS URL to inspect." },
    },
    required: ["url"],
  },
};

// ==========================================
// 3. GOOGLE CALENDAR (Shared & Personal)
// ==========================================

export const calQuery: FunctionDeclaration = {
  name: "cal_query",
  description: "Query calendar events in a date range. Returns compact IDs, times, and linked note_ids.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      start_iso: { type: Type.STRING, description: "Start ISO-8601 timestamp." },
      end_iso: { type: Type.STRING, description: "End ISO-8601 timestamp." },
      calendar: {
        type: Type.STRING,
        enum: ["mine", "partner", "both"],
        description: "Which calendar to check (default 'both').",
      },
    },
    required: ["start_iso", "end_iso"],
  },
};

export const calUpsert: FunctionDeclaration = {
  name: "cal_upsert",
  description: "Create a new calendar event or update an existing one by event_id.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      event_id: { type: Type.STRING, description: "Omit to create new; provide ID to update." },
      title: { type: Type.STRING, description: "Event title." },
      start_iso: { type: Type.STRING, description: "Start ISO-8601 timestamp." },
      end_iso: { type: Type.STRING, description: "End ISO-8601 timestamp." },
      note_id: { type: Type.STRING, description: "Optional note_id to attach to this event." },
      invite_partner: { type: Type.BOOLEAN, description: "True to include partner on the event." },
    },
    required: ["title", "start_iso", "end_iso"],
  },
};

// ==========================================
// 4. IMAP EMAIL (Search & Link in Notes)
// ==========================================

export const emailSearch: FunctionDeclaration = {
  name: "email_search",
  description: "Search cached IMAP emails by sender, subject, or keyword. Returns UIDs and snippets.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Search text (sender, subject, or keyword)." },
      folder: { type: Type.STRING, description: "Optional folder (default 'INBOX')." },
      limit: { type: Type.INTEGER, description: "Max results (default 5)." },
    },
    required: ["query"],
  },
};

export const emailRead: FunctionDeclaration = {
  name: "email_read",
  description: "Read the stripped plain-text/Markdown body of a specific email by UID.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      uid: { type: Type.STRING, description: "Email UID from email_search." },
    },
    required: ["uid"],
  },
};

// ==========================================
// 5. HARDWARE PRINTING & PERSONAL MEMORY
// ==========================================

export const printThermal: FunctionDeclaration = {
  name: "print_thermal",
  description: "Print a narrow receipt slip (checklists, recipes, quick reminders) to the thermal printer.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Header title printed in bold." },
      markdown: { type: Type.STRING, description: "Short Markdown body or bullet checklist." },
      checklist_mode: {
        type: Type.BOOLEAN,
        description: "True renders [ ] checkboxes cleanly for physical ticking.",
      },
    },
    required: ["title", "markdown"],
  },
};

export const printStandard: FunctionDeclaration = {
  name: "print_standard",
  description: "Send a full formatted note as a PDF to the standard regular printer.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      note_id: { type: Type.STRING, description: "ID of the note to print." },
    },
    required: ["note_id"],
  },
};

export const userProfileUpdate: FunctionDeclaration = {
  name: "user_profile_update",
  description: "Save a durable personal or household fact (allergies, preferences, IDs) to user memory.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      scope: {
        type: Type.STRING,
        enum: ["me", "partner", "shared"],
        description: "Who this fact applies to.",
      },
      key: { type: Type.STRING, description: "Short snake_case key (e.g., 'walnut_allergy')." },
      value: { type: Type.STRING, description: "Concise fact value." },
    },
    required: ["scope", "key", "value"],
  },
};

// Export single array for Gemini config
export const ALL_AGENT_TOOLS: FunctionDeclaration[] = [
  noteSearch,
  noteListRecent,
  noteOpen,
  noteCreate,
  noteEditDiff,
  noteHistory,
  webSearch,
  webReadPage,
  calQuery,
  calUpsert,
  emailSearch,
  emailRead,
  printThermal,
  printStandard,
  userProfileUpdate,
];

```

---

### 3. Compact Tool Return Formats (Keeping History Tiny)

What your Node backend returns *back* to Gemini matters even more than the input schema, because tool outputs stay in the conversation history for subsequent turns. Format every search/list return as dense, single-line strings:

* **`note_search` / `note_list_recent` output:**
```text
[note_14] "Date Night Spots" | folder:Personal | edited:2h ago by Sam | "...Thai place on 5th..."
[note_42] "Groceries" | folder:Home | edited:1d ago by Alex | "- [ ] Oat milk, sourdough..."

```


* **`email_search` output:**
```text
[uid_9021] 2026-11-11 | From: Delta <delta@delta.com> | Subj: Flight Confirmation | "Confirmation #H8K2L9..."

```


* **`note_edit_diff` implementation note:**
Because your notes use simultaneous CRDT/Yjs live editing, apply `note_edit_diff` directly to the active **Y.Text** document on your Node server (finding `target_text`'s index and calling `ytext.delete()` + `ytext.insert()`), rather than overwriting the `.md` file on disk. That way, if your girlfriend has the note open on her phone at that exact second, Gemini's edit streams live onto her screen with proper per-user attribution and zero merge conflicts.