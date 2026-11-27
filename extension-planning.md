# Extension Planning

## Problems & Reasons for the Switch

1. **BrightData is too slow**
   - Page fetching and especially web searches introduce too much latency.
2. **Calendar & Email integration barriers**
   - Many email inboxes (such as campus/university inboxes) are protected behind SSO/2FA and cannot be accessed via standard APIs.

---

## Core Idea

Keep **Mushnote** mostly as-is, but pull the web interface into a **browser extension**.

Instead of relying on external scraping proxies or restricted APIs, the extension leverages the user's existing, authenticated browser session.

---

## How This Transforms the Project

### 1. Replacing BrightData
- **Background AI browsing:** Searches and page fetches can be performed by the AI in a background tab behind the note, using the browser's native network stack and rendering engine.
- **Faster & richer:** No proxy overhead, and pages that require JS rendering or login state work out of the box.
- **User visibility:** Results and pages can be both parsed for the AI and presented directly to the user when needed.

### 2. Calendar & Email Integration
- Because the extension lives in the browser where the user is already signed in, it can interact with protected webmail (e.g., campus inboxes) and web calendars directly in the DOM/session—bypassing the need for institutional APIs or app passwords.

### 3. PWA + Extension Hybrid (Desktop-to-Mobile Bridge)
- **Keep the PWA:** Users can still install Mushnote as a PWA on their phones.
- **Remote execution:** When on mobile, Mushnote could route search/fetch requests through any open, extension-enabled desktop browser session connected to the user's account.

---

## Concrete Plans

### 1. Extension UI, Tabs & Entry Points
- **Toolbar Icon Toggle:** Clicking the extension icon (`chrome.action.onClicked`) opens or focuses Mushnote's hosted URL tab, keeping the user's current page in its own tab.
- **Browser-Native Tabs & Auto-Grouping:**
  - On desktop, each note opens as its own browser tab (removing internal Mushnote window tabs). Mobile PWA remains a single-tab experience.
  - Auto-group all Mushnote note tabs and AI-opened research tabs into a dedicated **"Mushnote" tab group** (`chrome.tabs.group`) so the user can physically see when the AI opens a site.
- **Hosted URL Detection:**
  - Inject a lightweight content script on the hosted Mushnote URL (or use `externally_connectable`) to perform a handshake on page load.
  - **If not installed:** Show a prompt to install the extension (with a fallback for mobile/PWA mode).
  - **If installed:** Initialize the Mushnote UI with extension capabilities enabled.
- **Quick-Capture Clipper:** Add a lightweight context menu / popup action to clip the active tab into a note.

### 2. Background Tab Runner (Replacing BrightData)
- **Tab Lifecycle:** Background service worker receives a search or page-read request, opens `chrome.tabs.create({ url, active: false })` inside the "Mushnote" tab group, waits for `status === "complete"`, extracts DOM/text via `chrome.scripting.executeScript`, and closes or keeps the tab as configured.
- **SPA & Lazy-Loading Handling:**
  - Wait for network idle or target selectors with a configurable timeout.
  - Run stepped `window.scrollTo` in background tabs to trigger `IntersectionObserver` lazy-loading, and optionally override `document.visibilityState` if a site gates rendering on tab focus.

### 3. Desktop-to-Mobile PWA Relay
- **Connection:** Maintain a WebSocket (or polling) channel between the Mushnote server and active desktop extension instances.
- **Routing:** When the mobile PWA requests a search or page fetch, the server routes the job to an online desktop extension session and returns the extracted result.
- **Fallback:** If no desktop extension session is online, surface a clear status message on mobile.

### 4. Inbox & Calendar Sync
- **On-Demand & Periodic Reads:** Read protected webmail (e.g., campus inboxes) and web calendars directly from the user's authenticated browser tabs/sessions.
- **Permission Boundaries:** Restrict reads to a user-configured domain allowlist.

### 5. Installation & Versioning
- **Version Handshake:** On load, the extension reports its `manifest.json` version to the hosted Mushnote app.
- **Noticeable Update Banner:** If outdated, display a persistent banner at the top of Mushnote that requires clicking an `X` to dismiss, with a direct update link.
- **Breaking Changes:** If below `minRequiredExtensionVersion`, block extension-dependent features with a clear modal until updated.
- **Toolbar Badge:** Set a `"!"` badge on the extension icon (`chrome.action.setBadgeText`) when an update is available.

---

## Checklist

### Phase 1: Foundation & Extension Setup
- [x] Create `extension-testing` branch
- [x] Create `chrome-extension/` directory
- [x] Scaffold `chrome-extension/manifest.json` (MV3, `tabs`, `tabGroups`, `scripting`, `storage`, `action`)
- [x] Scaffold `chrome-extension/background.js` (icon click toggle, lowercase `"mushnote"` tab group with accent color support, automatic origin memory, background tab fetcher)
- [x] Scaffold `chrome-extension/content.js` (`MUSHNOTE_EXT_READY` / `MUSHNOTE_EXT_PING` handshake & message bridge)
- [x] Tighten mobile detection (`ismobiledevice()` in `frontend/js/core/mobile.js`)
- [x] Keep mobile users on the mobile login/PWA flow
- [x] Show desktop extension install banner (`#ext-install-banner`) when extension is not detected and lock desktop `/editor` to extension-only

### Phase 2: Background Tab Runner & BrightData Replacement
- [x] Add frontend extension bridge helper (e.g. `window.mushnoteExtension` / `fetchPageViaExtension(url)`)
- [x] Route AI page-fetch tool calls through the extension when connected on desktop
- [x] Implement search runner via background tab (e.g. Google/DuckDuckGo search URL + result extraction)
- [ ] Add configurable timeout, SPA wait/network-idle handling, and `document.visibilityState` override if needed
- [x] Remove/bypass BrightData dependency when extension is active

### Phase 3: Browser-Native Tabs & UI Polish
- [x] Auto-group all Mushnote note tabs (`/editor`, `/note/*`) into the lowercase `"mushnote"` tab group
- [x] Remove internal Mushnote window tabs on desktop (keep single-tab experience on mobile PWA)
- [x] Wire `tab_manage` (`open`, `focus`, `close`) and `open_tabs` context into the AI
- [ ] Add quick-capture context menu / popup action to clip the active tab into a note
- [x] Make toolbar icon URL automatic via `MUSHNOTE_REGISTER_ORIGIN` (no hardcoded URL)

### Phase 4: Installation & Versioning
- [ ] Add `latestExtensionVersion` and `minRequiredExtensionVersion` config on the server
- [ ] Display persistent update banner (requiring `X` click to dismiss) when extension is outdated
- [ ] Display blocking modal when extension is below `minRequiredExtensionVersion`
- [ ] Set `"!"` badge on extension toolbar icon when an update is available

### Phase 5: Desktop-to-Mobile PWA Relay
- [ ] Add WebSocket/polling relay between Mushnote server and active desktop extension sessions
- [ ] Route mobile PWA search/fetch requests through an online desktop extension session
- [ ] Handle offline fallback gracefully on mobile when no desktop session is connected

### Phase 6: Inbox & Calendar Integration
- [ ] Build DOM/session readers for protected webmail (e.g. campus inboxes)
- [ ] Build DOM/session readers for web calendars
- [ ] Add domain allowlist settings for privacy and permission boundaries
- [ ] Wire inbox & calendar context into Mushnote AI tools
