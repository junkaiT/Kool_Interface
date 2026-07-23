# KoolAircon CRM — Web Interface Specification  
  
**Version:** 2.0   
**Date:** July 2026   
**Status:** Ready for build   
**Prepared for:** Developer / Builder AI  
  
---  
  
## 0. Critical Constraints (read first, do not violate)  
  
1. **Zero LLM involvement in any send path.** The interface is a UI skin, not a chatbot.  
2. **Telegram and WhatsApp must keep working as fallbacks at all times.** The interface is additive only — if it breaks, the operator falls back to Telegram and everything keeps running.  
3. **The bot's critical path has zero dependency on the interface.** If the web server crashes, the bot continues processing messages, bookings, and automation without interruption.  
4. **Do not modify existing command parsing logic in bot.js** beyond the three additions in Section 8. All command behaviour stays identical.  
5. **Bot commands from the web UI must pass through the existing Telegram Bot API** — not a parallel reimplementation in bot.js.  
  
---  
  
## 1. Overview  
  
A unified web-based operator interface for KoolAircon, allowing the operator to manage all customer conversations (Telegram and WhatsApp) from a single browser window. The interface is a UI layer only — all existing bot logic, command parsing, Google Sheets integration, and Google Calendar integration remain completely unchanged.  
  
**Design reference:** WhatsApp Web — familiar, fast, minimal.  
  
**Core principle:** The web interface does not replace Telegram or WhatsApp. Both remain fully operational as fallbacks at all times. This is additive only.  
  
---  
  
## 2. Architecture — Key Decisions  
  
These decisions were made deliberately. Do not revisit them.  
  
| Decision | Choice | Reason |  
|---|---|---|  
| Message storage | SQLite file on server | Fast, real-time, no Sheets API rate limits for high-frequency message reads/writes |  
| Structured data (contacts, jobs, queue, calendar) | Google Sheets API (existing service account) | Already the source of truth, changes rarely, Sheets rate limits are acceptable for this data |  
| Real-time message delivery | WebSocket | No polling lag, push-based, one connection per operator |  
| Web server location | Added to existing webhook handler in index.ts | No new process, no new port, no new supervisor config |  
| Command send path | Browser → Telegram Bot API → bot.js (unchanged) | Bot receives commands identically to Telegram — no new code path |  
| Compose UI | Single input box | / prefix = bot command, plain text = direct customer message. Matches Telegram behaviour the operator already knows |  
| Authentication | Single shared password (env variable) | Single operator, v1 — no audit trail requirement yet |  
| Failure isolation | Interface reads/writes independently of bot | Web server crash = interface dead, bot unaffected |  
  
### What the interface reads from where  
  
| Data | Source | Notes |  
|---|---|---|  
| Message thread (live) | SQLite on server | Real-time via WebSocket |  
| Message history | SQLite on server | Loaded on conversation open |  
| Thread list | 6_Operator_Inbox (Sheets) | Polled every 30 seconds |  
| Customer info | 1_Contacts (Sheets) | Loaded on conversation open |  
| Jobs | 2_Jobs (Sheets) | Loaded on conversation open |  
| Module 3 queue | Module3_Queue (Sheets) | Polled every 30 seconds |  
| Calendar events | Google Calendar API | Loaded on day select |  
| Settings | 9_Settings (Sheets) | Loaded on startup |  
  
---  
  
## 3. Layout — Three-Column Structure  
  
```  
┌──────────────┬──────────────────────────┬─────────────────┐  
│ Thread list │ Chat panel │ Calendar panel │  
│ (230px) │ (flexible) │ (220px) │  
│ │ │ │  
│ Unified │ Header │ Mini month │  
│ inbox of │ ───────────────────── │ view │  
│ all Tele- │ Customer info panel │ │  
│ gram and │ (collapsible) │ Job list for │  
│ WhatsApp │ ───────────────────── │ selected day │  
│ convos │ Message thread │ │  
│ │ ───────────────────── │ Toggleable │  
│ │ Compose box │ via header │  
│ │ (single input) │ icon │  
└──────────────┴──────────────────────────┴─────────────────┘  
```  
  
All three panels are toggleable. The calendar panel and customer info panel can each be collapsed independently via icons in the chat header.  
  
---  
  
## 4. Thread List (Left Panel)  
  
### 4.1 Header  
- App title: "KoolAircon CRM"  
- Search box: filters thread list by customer name or phone number  
  
### 4.2 Thread Row  
Each row shows:  
- **Avatar** — initials, colour-coded by channel (blue for Telegram, green for WhatsApp)  
- **Name** — customer name from 1_Contacts  
- **Timestamp** — time of last message (today) or day name (this week) or date (older)  
- **Preview** — last message text, truncated  
- **Channel pill** — `Telegram` (blue) or `WhatsApp` (green)  
- **Status pill** — pulled from Contact_Status in 1_Contacts:  
  
| Status value | Pill label | Pill colour |  
|---|---|---|  
| Lead | Lead | Purple |  
| Customer | Customer | Green |  
| Booked | Booked | Amber |  
  
- **Unread dot** — shown when there are unread inbound messages (tracked in SQLite)  
  
### 4.3 Behaviour  
- Clicking a thread opens it in the chat panel  
- Active thread is visually highlighted  
- New inbound messages (pushed via WebSocket) cause the relevant thread to move to the top of the list and show an unread dot  
- Thread list data sourced from 6_Operator_Inbox + 1_Contacts, polled every 30 seconds  
  
---  
  
## 5. Chat Panel (Centre)  
  
### 5.1 Header Bar  
- Customer avatar (initials)  
- Customer name + status badge  
- Channel and contact detail (e.g. "WhatsApp · +65 9123 4567" or "Telegram · @username")  
- Two icon buttons (right-aligned):  
 - **User icon** — toggles the customer info panel open/closed  
 - **Calendar icon** — toggles the calendar panel open/closed  
  
### 5.2 Customer Info Panel (collapsible)  
Collapsed by default. Shows:  
  
**Column 1 — Job history**  
- Last job: date + service type + unit count  
- Total jobs (from 2_Jobs, filtered by Contact_ID)  
  
**Column 2 — Household flags**  
- Elderly present ✓ / –  
- Children ✓ / –  
- Pets ✓ / –  
- Google review given ✓ / –  
  
**Column 3 — Property**  
- Address  
- Postal code  
- Assigned team  
  
All data sourced from 1_Contacts and 2_Jobs. Read-only.  
  
### 5.3 Message Thread  
Scrollable conversation history sourced from SQLite. Three distinct message types:  
  
| Type | Alignment | Style |  
|---|---|---|  
| Inbound (customer) | Left | White bubble, thin border |  
| Outbound direct (operator typed in Box 1) | Right | Blue bubble |  
| Bot command (operator typed / prefix) | Right | Grey monospace bubble, labelled "via bot" |  
| Bot response (draft, confirmation, error) | Centre | Grey system message |  
  
**Draft messages** (Module 3 queue entries awaiting approval):  
- Shown with a dashed border  
- Labelled "Draft · pending approval"  
- Three action buttons: **Edit**, **Discard**, **Send**  
- Send triggers Q-NNN command via Telegram Bot API  
  
### 5.4 Compose Area (single input box)  
  
One input box. Behaviour determined by prefix:  
  
- **Plain text** → sent directly to the customer via the correct channel (sendTelegram or sendWhatsApp based on contact.Source)  
- **/ prefix** → treated as a bot command, sent via Telegram Bot API as if the operator typed it in Telegram. The INBOX ID is inferred automatically from the open conversation — the operator types `/b GC 3` not `/b INBOX-089 GC 3`  
  
Placeholder: `Message customer or /command…`  
  
Input uses monospace font when / is detected (first character), switches to regular font otherwise.  
  
**Send button behaviour:**  
- Plain text: calls web server API → server calls sendTelegram/sendWhatsApp → logs to SQLite → pushes to WebSocket  
- /command: calls Telegram Bot API directly with inferred INBOX ID prepended → bot processes normally → response comes back via WebSocket (notifyFn extension, see Section 8)  
  
---  
  
## 6. Calendar Panel (Right)  
  
Toggleable via calendar icon. Default: visible.  
  
### 6.1 Mini Month View  
- Standard month grid  
- Dots beneath dates with scheduled jobs  
- Today highlighted  
- Selected day highlighted  
- Previous/next month navigation  
  
### 6.2 Job List  
Below the month grid. Jobs for selected day in time order. Each card shows:  
- Time slot  
- Customer name  
- Service type + unit count  
- Job status  
  
The job card for the currently open conversation is highlighted with an accent border.  
  
### 6.3 Data source  
Google Calendar API — read-only via existing service account credentials.  
  
---  
  
## 7. Send Path Logic  
  
### Path A — Direct customer message (plain text in compose box)  
```  
Operator types plain text → Send button →  
Web server checks contact.Source for channel →  
Calls sendTelegram(contactId, text) OR sendWhatsApp(contactId, text) →  
Message delivered to customer →  
Logged to SQLite as outbound-direct →  
Pushed to all connected WebSocket clients  
```  
  
### Path B — Bot command (/ prefix in compose box)  
```  
Operator types /command (e.g. /b GC 3) → Send button →  
Browser prepends INBOX ID from current conversation context →  
Calls Telegram Bot API: sendMessage(OPERATOR_TELEGRAM_ID, "/b INBOX-089 GC 3") →  
Bot receives as normal Telegram operator message →  
Bot processes identically to if operator typed in Telegram →  
Bot response (draft, confirmation, error) comes back via notifyFn → WebSocket → browser  
Command logged to SQLite as bot-cmd  
```  
  
**Zero LLM involvement in either path.**  
  
---  
  
## 8. Required Changes to Existing Code  
  
These are the ONLY changes to existing bot code. Everything else is new files.  
  
### 8.1 SQLite message logging (db.js — new file)  
New module `crm/db.js` — SQLite wrapper. Schema:  
  
| Field | Type | Notes |  
|---|---|---|  
| id | INTEGER | Primary key, autoincrement |  
| conversation_id | TEXT | Contact_ID (e.g. KA-0042) |  
| channel | TEXT | `telegram` or `whatsapp` |  
| direction | TEXT | `inbound` or `outbound` |  
| message_type | TEXT | `direct`, `bot-cmd`, `draft`, `bot-resp` |  
| text | TEXT | Message content |  
| timestamp | INTEGER | Unix ms timestamp |  
| sender | TEXT | Contact_ID or `operator` |  
| read | INTEGER | 0 = unread, 1 = read |  
  
Wire `db.insert(message)` into:  
- `handleInboundMessage()` in bot.js — on every customer message received  
- `sendTelegram()` in bot.js — on every outbound send to customer (not operator notifications)  
- `sendWhatsApp()` in whatsapp.js — on every outbound send to customer  
  
These are one-line additions at existing send points. No logic changes.  
  
### 8.2 notifyFn extension  
The `notifyFn` pattern already exists in `handleOperatorApproval`. Extend it to:  
- `handleBookingCommand` — so slot options appear in browser via WebSocket  
- `handleConfirmSlot` — so confirmation drafts appear in browser  
- `handleCalInfo` — so calinfo responses appear in browser  
  
These handlers currently send Telegram messages directly. The extension adds an optional `notifyFn` parameter — if provided, responses go via WebSocket instead of (or in addition to) Telegram. Default behaviour unchanged.  
  
### 8.3 INBOX ID inference for web-originated commands  
When the compose box sends a /command, the browser prepends the INBOX ID before sending to the Telegram Bot API. No changes needed in bot.js — the bot receives a fully-formed command as if typed in Telegram.  
  
---  
  
## 9. New Infrastructure  
  
### 9.1 SQLite database  
File: `/home/ubuntu/.openclaw/workspace/crm/messages.db`   
Library: `sql.js` (WASM) — not `better-sqlite3` as originally spec'd; `better-sqlite3` needs node-gyp/a C++ toolchain that wasn't reliably available in the deployment environment, so Phase 1 shipped on the pure-JS `sql.js` fallback behind the same `db.js` function signatures instead.   
No separate process — accessed directly by both bot.js and the web server.  
  
### 9.2 Web server (added to index.ts)  
NOT a separate process. Added directly to the existing OpenClaw webhook handler alongside the WhatsApp webhook routes.  
  
Endpoints needed:  
- `GET /ui` — serves the interface HTML file  
- `GET /api/threads` — returns active conversations from 6_Operator_Inbox + 1_Contacts  
- `GET /api/messages/:contactId` — returns message history from SQLite  
- `GET /api/customer/:contactId` — returns contact + job data from Sheets  
- `GET /api/queue` — returns Module3_Queue from Sheets  
- `GET /api/calendar/:date` — returns events from Google Calendar  
- `POST /api/send` — direct message send (Path A)  
- `WebSocket /ws` — real-time push channel  
  
### 9.3 Authentication  
Single shared password stored as environment variable `UI_PASSWORD`.   
Simple HTTP Basic Auth or a session token checked on WebSocket connection.   
No user accounts, no per-staff permissions in v1.  
  
### 9.4 Interface file  
Single HTML file with embedded CSS and JavaScript.   
No build system, no npm, no framework — vanilla JS + CSS only.   
Served as a static file from the web server.   
Deployable by dropping one file onto the server.  
  
---  
  
## 10. Build Phases  
  
| Phase | What | Risk | Dependency |  
|---|---|---|---|  
| 0 | Git-init live code, push to private GitHub repo | None | Do first |  
| 1 | db.js SQLite wrapper + wire logging into inbound/outbound points | Low — additive only | Phase 0 |  
| 2 | notifyFn extension to remaining command handlers | Medium — touches existing handlers | Phase 0 |  
| 3 | Web server + WebSocket + auth added to index.ts | Low — new routes only | Phase 1 |  
| 4 | Read-only interface HTML — thread list, chat view, customer panel, calendar | Low — frontend only | Phase 3 |  
| 5 | Direct message send (plain text compose) | Low | Phase 4 |  
| 6 | Bot command send (/ prefix compose, INBOX ID prepended in browser) | Low | Phase 4 |  
| 7 | Draft approval UI (Edit / Discard / Send buttons for Module3_Queue) | Low — frontend only | Phase 6 |  
| 8 | Status pills, unread dots, thread sorting | Low — frontend only | Phase 4 |  
  
**Phases 0–3 are backend. Phases 4–8 are primarily frontend.**   
Each phase is independently deployable and testable.   
If any phase breaks, roll back that phase only — earlier phases and the bot are unaffected.  
  
---  
  
## 11. Failure Modes and Fallbacks  
  
| What breaks | Impact on bot | Impact on interface | Operator fallback |  
|---|---|---|---|  
| Interface HTML/JS bug | None | Interface broken | Use Telegram |  
| Web server crash | None | Interface dead | Use Telegram |  
| SQLite write fails | Caught, logged, bot continues | Message missing from thread | Use Telegram |  
| SQLite file corrupted | None — bot never reads SQLite | Interface history lost | Use Telegram |  
| WebSocket drops | None | Interface shows stale messages | Refresh browser |  
| Sheets API timeout | Bot degraded (existing issue) | Interface shows stale data | Use Telegram |  
| Bot crashes | Bot down | Interface shows history but can't act | Manual / wait for restart |  
  
**The only shared failure point is Google Sheets** — already true today regardless of the interface.  
  
---  
  
## 12. Out of Scope (v1)  
  
Do not build these now:  
  
- Multi-staff routing or conversation assignment  
- WhatsApp 24-hour messaging window / Meta-approved template management  
- Non-text message support (photos, voice notes, location pins)  
- Mobile-optimised layout (desktop browser only)  
- Per-staff permission levels  
- Push notifications when new messages arrive (browser is closed)  
- Analytics or reporting dashboard  
- Message search across history  
- Bulk actions on threads  
  
---  
  
## 13. Infrastructure Context (for the builder)  
  
```  
Server: MyClaw hosted container (OVH/Docker)  
Accessed via: OpenClaw web interface (no direct SSH)  
Gateway restart: supervisorctl -c /tmp/supervisord-openclaw.conf restart openclaw-gateway  
Existing webhook port: 18789 (web server adds routes here)  
Public webhook URL: https://flatly-aviator-turf.ngrok-free.dev  
Google Sheet ID: 1YSU2zdeijOyp4KZYxav6ASoLLNst6IrPZ5Vo2lB05p4  
Service account: openclawcrm@aircon-crm-499108.iam.gserviceaccount.com  
Shared Drive ID: 0AD-hRMQ3c1ugUk9PVA (source files live here)  
Operator Telegram ID: 126686924  
Bot token: in crm/bot.js (BOT_TOKEN)  
WhatsApp access token: in crm/whatsapp.js (permanent system-user token)  
  
Source files (read from Shared Drive before starting):  
- crm/bot.js (251 lines) — as of v3 (17 Jul 2026), split into domain files below; this is no longer the monolith
- crm/crm.js (989 lines)  
- crm/booking.js  
- crm/module3.js  
- crm/reports.js  
- crm/templates.js  
- crm/scheduler.js (602 lines)  
- crm/sheets.js (770 lines)  
- crm/calendar.js (238 lines)  
- crm/whatsapp.js (361 lines)  
- .openclaw/extensions/koolaircon-crm/index.ts (820 lines)  
```
