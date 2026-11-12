# todo list

## completed --------------------
- [x] nodejs backend structure in backend folder
- [x] yaml configuration loader with fallback auto generation
- [x] configurable markdown notes vault
- [x] yjs and websocket real time collaborative sync engine
- [x] per user edit history tracking with sqlite database and audit events log
- [x] recursive vault fs watch for external edits with external attribution, gray flash, and no avatar
- [x] support for all text files (md, txt, json, yaml, csv, py, js, etc) in vault and ai tools
- [x] user profiles and avatar static serving
- [x] basic rest api for notes, history, and users
- [x] gitignore setup for notes, history, avatars, and configs
- [x] oled minimal login screen with user picker
- [x] password setup and scrypt salt and hashing saved into config yaml
- [x] session management and token authentication
- [x] two column workspace layout with collapsible directory tree
- [x] note viewer and live auto-saving text editor
- [x] create and delete notes modal and endpoints

## gemini agent --------------------
- [x] install and configure @google/genai client
- [x] configure minimal thinking budget and tokens to keep costs low
- [x] dynamic system prompt generator with local date and time (12h am or pm), active user, events, and emails
- [x] weather data in context from location config
- [x] location in system prompt context
- [x] open tabs list in system prompt context
- [x] active open note content injection in context for zero-tool latency and token savings
- [x] right click copy conversation with thinking prompts and responses in json
- [x] collapsible thought and tool dropdowns with visual names and smooth closing animation
- [x] interactive clickable option chips for multiple-choice, quizzes, and yes/no questions
- [x] note_search tool (fuzzy search returning compact ids and snippets)
- [x] note_list_recent tool (recent notes filtered by author)
- [x] note_outline tool (view note headings and line numbers for large notes)
- [x] note_open tool with heading chunking and line slicing for token conservation
- [x] note_open_for_user tool (open note in tab for user)
- [x] note_create tool (create new markdown note)
- [x] note_move tool (rename or move notes and folders)
- [x] note_copy tool (copy notes and folders)
- [x] note_edit_diff tool (apply diff to live yjs document)
- [x] note_history tool (query revision diffs)
- [x] user_profile_update tool (save durable user and household memory)
- [ ] web_search tool (searx or duckduckgo search)
- [ ] web_read_page tool (lightweight page reader proxy to markdown)
- [x] chat endpoint for agent conversations with automatic tool loop
- [x] in-app ai assistant chat drawer with live note sync

## integrations --------------------
- [ ] google calendar integration for user and partner
- [ ] cal_query tool (query events with attached note ids)
- [ ] cal_upsert tool (create and update events)
- [ ] imap email integration for inbox sync and unread counts
- [ ] email_search tool (search cached emails by sender or subject)
- [ ] email_read tool (read stripped email body)

## frontend and pwa --------------------
- [x] live edit flash animation with user color highlights from preferences yaml
- [x] remember last open note across sessions and devices via user preferences
- [x] full top-to-bottom distraction-free editor without header bar
- [x] split frontend into dedicated login and editor-ui html pages and modular js
- [x] floating square side arrow toggles above sidebars, partly inside panels when opened
- [x] horizontal smooth tab dragging with fluid spring reordering and edge auto-scroll
- [x] visual desktop checkbox component for detailed view in ai context menu
- [x] right click context menu on empty area or folders to create new note
- [x] auto-navigate and open newly created notes directly
- [x] instant responsive resizable columns for files sidebar, editor, and ai drawer with drag handles
- [x] smooth animated open and close for sidebar and ai assistant drawer
- [x] context menu on notes and folders for rename and delete with confirmation
- [x] context menu new folder action and recursive folder delete
- [x] clipboard cut copy and paste for notes and folders
- [x] hide system folder from folder tree with right-click menu navigation for all users
- [x] files drawer toggle button in editor header
- [ ] minimal oled black theme (#000000)
- [ ] markdown editor with live yjs websocket collaboration
- [ ] notes sidebar with search and folder navigation
- [ ] user profile selector showing avatars
- [ ] mobile pwa setup with manifest and service worker
- [ ] offline editing support with local indexdb sync
- [ ] mobile view opening directly to ai agent assistant

## accounts and external api --------------------
- [ ] settings ui to manage user accounts and connections
- [ ] api tokens for other projects to save and read notes (they should have to register another user -- but rename ai to bot for easier)

## future hardware (on hold) --------------------
- [ ] thermal receipt printer integration (print_thermal)
- [ ] regular printer pdf export and print (print_standard)


more ideas:
- built in code editor with syntax highlighting and help from ai
- WYSIWYG markdown editing
- right click menu on notes in file menu
- resizable columns
- history viewer and reverter (including deleted notes)
- small python script running functionality?
- uploading text, pdf, (auto OCR), sound? video?
- add transcribing audio (and audio from video) and mic text input (mobile)
- youtube video link paste (and can convert too)
- allow Latex and MD visualization in chat and notes
- take pictures and anaylze pictures
- setting icons for notes / folders
- copy button for code blocks too
- make background color easier to understand and actually look good
- conversation keeping , switching, and sharing conversations between users
- make it want to edit your personal document when you tell it things
- conversation compression (a little aggresive, saving money focus, but also make sure tool uses are quickly folded)
- some sort of graphing capability (flow chart and graphs)
- make funny little hand-drawn icons for every action and button
- highlight text --> right click --> ask ai

name ideas:
- mushnote

- [x] admin default
- [x] make login index.html and navigate to it by clicking user box in editor
- [x] admin field beneath username and default admin user with no auth
- [x] admins can create/delete accounts and view system files for accounts other than their own
- [x] rename role field to bot: true or false
- [x] add ai-username field under gemini api key defining
- [x] quizzing proactively asks next question
- [x] settings screen with color pickers and text inputs (admin for anyone, non-admin for self)
- [x] quick button to jump to personality note
- [x] preserve open tabs, active note, and folder navigation when jumping between editor and index
- [x] copy conversation and expanded thinking/tool use only for admin (clean gray status lines for non-admin)
- [x] hover copy icon button under prompts and responses for both admin and non-admin
- [x] fix notes tree visibility when switching accounts or when no note was previously open
- [x] lock ai system files (personality and preferences) to admin only
- [x] non-admin thinking and action status lines disappear after response is done
- [x] allow ai to open notes for user in a new tab
- [x] show user icon on bottom right corner of edit highlight
- [x] detailed view checkbox in chat context menu (off by default for non-admins, on by default for admins)
- [x] live cursor for users on a note with user color and avatar below and to the right
- [x] resilient note editing with insert_after, insert_before, delete, batch edits, and normalized matching
- [x] fix auto-opening newly created ai notes in a new editor tab
