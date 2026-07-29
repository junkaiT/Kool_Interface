KoolAircon CRM

System Documentation

Version 4.0 | July 2026 | KoolAircon Pte Ltd

This document replaces v3 (17 July 2026). Major addition: the browser CRM interface (`/ui`) — a WhatsApp-Web-style operator dashboard built across ten phases on top of the existing Telegram-bot backend, adding thread list, chat panel, customer-info editing, calendar/booking panel, and a Reminder Queue approval UI for Module 3 drafts. Telegram remains fully functional as a fallback at all times; nothing about the existing bot command logic changed except the extraction described in Part 3.10.

**Revision note (29 July 2026):** four follow-up phases landed on top of the v4 base and are folded into this same document rather than issued as a new version, since none of them change the architecture described above — they're fixes and one feature built on it. Summary: (1) `Total_Jobs`/`Total_Spend_SGD` in `1_Contacts` switched from a spreadsheet formula to a code-computed batch update (was silently inflating the sheet to 1000+ rows — see 2.3, 3.10.7); (2) the WhatsApp webhook now logs Meta's delivery-status callbacks instead of discarding them (3.10.8); (3) a real production incident — approved-looking Module3 reminder sends that never reached the customer's phone — was root-caused to sending Marketing-tier content as free text outside the 24-hour customer service window, **not yet fixed** (see 3.5, 3.7); along the way, a template-placeholder case-sensitivity bug (`{{name}}` never matching a `Name` vars key) was found and fixed (3.10.9); (4) a mobile-responsive layout was added to `ui.html` (3.10.10). See the revision note in each cross-referenced section for detail.

Four parts: Part 1 — Operator quick reference (Telegram + Browser). Part 2 — How the system works. Part 3 — Technical annex for rebuilding. Part 3.10 — Browser CRM UI technical reference (new in v4).

Part 1 — Operator Quick Reference

All commands are typed to @JKaircon_bot on Telegram. Only the registered operator (ID 126686924) can run them. Everything in this section also works from the browser CRM (see 1.6) — the browser sends the same commands through the same handlers.

1.1 Normal Booking Flow

| Step | Command | What happens |
| :-: | :-: | :-: |
| 1 | Customer messages via WhatsApp or Telegram | Contact + inbox entry created automatically. LEAD-INIT-A auto-sent. Operator notified on Telegram. |
| 2 | /info INBOX-NNN address \| postal \| phone | Saves address, postal code, phone to 1_Contacts. Updates zone lookup. |
| 3 | /b INBOX-NNN GC 3 | Finds available slots. GC/CW/CO/KJ/AS = service code. 3 = units. Shows draft slot offer. |
| 4 | Customer replies with choice | Customer picks a slot option (1, 2, or 3). |
| 5 | /confirm INBOX-NNN 2 | Locks in option 2. Add @ 14:30 for specific start time. |
| 6 | INBOX-NNN | Sends confirmation to customer + creates job in 2_Jobs + creates calendar event. |

1.2 Full Command Reference

| Command | Example | What it does |
| :-: | :-: | :-: |
| /info | /info INBOX-001 Blk 123 Tampines \| 520123 \| 91234567 | Save contact details (positional). Or named: /info INBOX-001 Full_Name: Mrs Tan \| Phone: 91234567. Works on INBOX-NNN or KA-XXXX. |
| /b | /b INBOX-001 GC 3 | Generate slot options. Checks zone, team schedule, calendar availability. |
| /confirm | /confirm INBOX-001 2 @ 14:30 | Lock in slot. Creates draft confirmation — does NOT send yet. |
| INBOX-NNN | INBOX-001 or INBOX-001 custom msg | Final approval — sends to customer, creates job. Add text to override draft. |
| /in | /in INBOX-001 | Alias for bare INBOX-NNN. |
| /confirmb | /confirmb INBOX-003 | Confirm from existing calendar event. Needs bare INBOX-NNN afterward. |
| /checkCal | (no args) | Scan all team calendars for manual events without a job. Creates inbox entries. |
| /calinfo | /calinfo INBOX-006 CW 3 | Set service type and units for a /checkCal booking. |
| /mixyes | /mixyes INBOX-005 | Re-search across all teams (when home team slot > 7 days out). |
| /mixno | /mixno INBOX-005 | Re-search using home team only. |
| /sendphotos | /sendphotos INBOX-001 | Manually trigger photo bundle send to customer. Add force to resend. |
| Q-NNN | Q-001 | Approve and send a Module 3 queued draft message (Telegram 3-digit form — see 1.6 for the browser equivalent). |
| /asCustomer | /asCustomer Sarah test message | Testing only — simulates an inbound customer message. |

1.3 Web Booking Flow

When a customer books via kool-pi.vercel.app/book, the flow is:

Customer fills form (name, phone, address, postal, service, units) and selects a slot

Taps button → WhatsApp opens with pre-filled booking message

Customer sends → opens 24-hour Free Entry Point (FEP) — zero cost for follow-up messages

CRM detects structured message, auto-creates contact + inbox, saves all details

Operator gets Telegram alert with pre-filled /b command to confirm

Operator runs /b INBOX-NNN, selects the slot matching the customer's request

Customer confirmed via WhatsApp in the free FEP window

Note: this is a separate public-facing booking widget hosted on the Kool Aircon marketing site (kool-pi.vercel.app), not the operator-facing browser CRM described in 1.6. It only talks to the CRM backend through `GET /booking/slots` (see 2.6) — it never touches `/ui` or `/api/*`.

1.4 Photo Bundle Flow (YES Reply)

After job completion, POST-D0-UTIL utility template is sent to customer with a YES quick reply button:

Customer taps YES → CRM auto-detects YES reply → triggers photo bundle send

If customer says "Yes please send" (ambiguous) → operator gets Telegram nudge with /sendphotos INBOX-NNN command

Operator can also manually trigger: /sendphotos INBOX-NNN at any time

Bundle sends: intro text → before/after photos by room → dust photos → dirty water video → closing text with report link

1.5 9_Settings — Operational Controls

Edit directly in the sheet — most take effect within 60 seconds without a restart.

| Setting | Default | What it controls |
| :-: | :-: | :-: |
| Module3_AutoSend | FALSE | If TRUE, Module 3 messages send automatically. Keep FALSE until system is fully trusted. |
| Sweep_Hour_SGT | 8 | Hour (SGT, 24hr) when daily reminder sweep runs. Gate is in-process (see 3.3) — resets on gateway restart. |
| Days_Ahead | 14 | How many days forward the scheduler searches for slots. |
| Travel_Buffer_Mins | 15 | Extra buffer on top of Google Maps travel estimate. |
| Buffer_Same_Zone_Mins | 30 | Travel buffer when next job is in same zone. |
| Buffer_Overflow_Mins | 45 | Travel buffer when covering overflow zone. |
| Inbox_Purge_Days | 7 | Operator inbox entries older than this are auto-deleted. |
| Work_Block_AM_Start/End | 9:00 / 12:00 | Morning working block boundaries. |
| Work_Block_PM_Start/End | 13:00 / 18:00 | Afternoon working block boundaries. |
| WA_Business_Number | 6596687419 | WhatsApp number used in booking page deep links. Update when real business number is live. |
| URL_Book_Online | kool.com.sg/book | Booking page URL used in message templates. Update when domain is live. |
| URL_Review | kool.com.sg/review | Google review link. Update when Google Maps listing is live. |
| URL_Referral | kool.com.sg/refer | Referral programme page. Update when page is built. |
| MD_Name | Jun Kai | Used in REM-4-A personal outreach message. |
| Tech_Processed_Submissions | (auto) | Comma-separated Drive file IDs of processed technician submissions. Do not edit manually. |

1.6 Browser CRM Quick Reference (new in v4)

URL: `https://<current-ngrok-url>/ui` — prompts for HTTP Basic Auth; any username, password = `UI_PASSWORD` (set in supervisord environment). The browser caches the credential after the first prompt.

| Panel | Icon | What it does |
| :-: | :-: | :-: |
| Thread list | (left, always visible) | Every conversation ever logged to SQLite, newest activity first. Search box filters by name/id. Unread dot + count on inbound messages. |
| Customer info | 👤 | Job history (expandable full table), household flags (elderly/children/pets/review), and an **editable** Address/Postal/Phone form with a Save button. |
| Calendar | 📅 | Mini month view → click a date to see that day's jobs across all teams. Click a job card to expand address/postal/phone/price (parsed from the calendar event description). Below it: a "New booking" panel (service + units → Find slots → click a slot → Send to customer) and a "Manual Calendar Addition" button (runs `/checkCal` without leaving the browser). Mutually exclusive with the Reminder Queue panel — opening one closes the other. |
| Reminder Queue | 📋 | Every pending `Module3_Queue` draft. Edit the text and **Save edit**, **Discard** without sending, or **Approve & Send** (sends whatever is currently in the box, saved or not, and removes it from the queue). Mutually exclusive with the Calendar panel. |
| Help | ❓ | In-app instructions matching this section. |

**Compose box** (bottom of the chat panel, once a thread is open): plain text sends directly to the customer (Path A). Anything starting with `/` or a bare `INBOX-NNN` is treated as a bot command (Path B) and dispatched through the exact same handler Telegram uses — you do **not** need to know or type the INBOX id yourself; the browser resolves the open inbox for that contact automatically (falling back to the raw Contact_ID if none is open). If a command's usual Telegram error text mentions typing an INBOX id, the browser response appends a one-line note telling you to skip it.

**Approving a Reminder Queue draft is a real send** — clicking "Approve & Send" delivers that WhatsApp/Telegram message to the customer immediately, exactly like replying `Q-NNN` in Telegram. There is no separate confirmation step.

Part 2 — How the System Works

2.1 System Architecture

The CRM is a plugin running inside OpenClaw on an OVH server (Docker container). It is NOT an AI chatbot — every customer-facing message is built from fixed templates or typed by the operator.

| Component | What it does | Status |
| :-: | :-: | :-: |
| OpenClaw (OVH server) | CRM plugin host — handles all logic, Sheets reads/writes, Calendar sync | Live |
| Google Sheets | CRM database — contacts, jobs, templates, settings, logs | Live |
| Google Calendar | Booking schedule source of truth | Live |
| WhatsApp Business API | Customer messaging channel (test credentials) | Live (test) |
| Telegram Bot | Operator notification and command interface | Live |
| Browser CRM (`/ui`) | Operator dashboard — thread list, chat, customer editing, calendar/booking, Reminder Queue | Live (v4) |
| SQLite (`sql.js`) message log | Backs the browser's message thread and thread list | Live (v4) |
| ngrok | Exposes OpenClaw to internet for Meta webhooks and `/ui`. URL changes on restart. | Live (free tier) |
| Vercel (kool-pi.vercel.app) | Hosts booking page frontend | Live |
| Google Drive | Technician app photo storage, code backup, deploy-file staging | Live |
| GitHub Pages | Hosts technician app (index.html) | Live |
| Cloudflare Tunnel | Planned replacement for ngrok — needs kool.com.sg domain first | Deferred |

2.2 Dual-Channel Architecture

| | Customer on WhatsApp | Customer on Telegram |
| :-: | :-: | :-: |
| Inbound path | POST /webhook/whatsapp → handleInboundMessage() | before_agent_reply hook → handleInboundMessage() |
| Operator notified | Telegram (always) + browser (via SQLite, next poll) | Telegram (always) + browser |
| Reply to customer | sendWhatsApp(contactId, text) | sendTelegram(contactId, text) |
| Channel detection | contact.Source.includes("WhatsApp") | Default — Telegram assumed if not WhatsApp |
| Booking page | Opens WA deep link → customer sends message → FEP opens | N/A — booking page is WhatsApp-first |

2.3 The Google Sheets Database

Sheet ID: 1YSU2zdeijOyp4KZYxav6ASoLLNst6IrPZ5Vo2lB05p4

| Tab | What it holds | Key columns |
| :-: | :-: | :-: |
| 1_Contacts | Every customer and lead | Contact_ID, Full_Name, Channel_Contact_ID, Phone, Address, Postal_Code, Assigned_Team, Last_Job_Date, Opt_Out, Units_In_Home, Unit_Age_Years, Aging_Unit |
| 2_Jobs | Every job | Job_ID, Contact_ID, Status, Job_Date, Service_Type, Units_Serviced, Completed_At, Arrival_Time, Post_Job_Sent, Photos_Sent, Star_Rating, Noise_Reported, Tech_Sub_ID |
| 3D_Teams | Team definitions | Team_ID, Team_Name, Calendar_ID, Active, technician emails for app identity lookup |
| 4_Templates | Message templates | Template_ID, WA_Template_Name, Message_Text ({{param}} format), Trigger_Type, Status, Message_Type (utility/marketing/service) |
| 5_Message_Log | All messages sent/received | Direction, Channel, Message_Text, Template_ID, Sent_By, Status |
| 6_Operator_Inbox | Active enquiries awaiting operator | Inbox_ID, Contact_ID, Status, Customer_Message, Draft_Reply |
| 7_Postal_Zones | Zone lookup by postal prefix | Zone_ID, Postal_Sector prefixes |
| 8_Service_Durations | Job duration per service/units | Service_Type, Units, Duration_Mins |
| 9_Settings | Operational constants | Key, Value — edit directly, most take effect in 60s |
| 10_Pricing Table | Price per service/units | Units, GC, CW, CO, AS prices |
| Team_Schedule | Per-team per-day zone coverage | Team_ID, Day, Primary_Zone, Overflow_Zone — cached, propagates within 60 minutes |
| Module3_Queue | Pending draft messages | Queue_ID (Q-YYYYMMDD-NNN), Contact_ID, Template_ID, Generated_Date, Channel, Draft_Text — deleted on send/discard or after 14 days |

**Note on `Module3_Queue.Contact_ID`**: this column holds the internal `KA-XXXX` contact id, not a phone/Telegram id. Anything that sends to a queue entry must resolve the real `Channel_Contact_ID` via `1_Contacts` first — see 3.10.4 for the bug this caused and its fix.

**`Total_Jobs` / `Total_Spend_SGD` (29 July 2026 revision) are code-computed, not a spreadsheet formula.** They used to be a dragged-down formula, which silently caused `1_Contacts` to balloon to 1000+ rows (the formula's presence in a cell fooled the "first empty row" append logic used elsewhere) and had to be manually cleared. They're now recomputed every 15 minutes by `recomputeContactTotals()` (3.10.7). **Do not re-add a formula to these columns** — it will immediately start fighting with the code's writes and can reintroduce the same row-bloat.

2.4 Message Template System

All message templates use {{double_curly_braces}} for parameters (Meta WhatsApp Business API format). Three message types:

| Type | When used | Cost | Templates |
| :-: | :-: | :-: | :-: |
| Service message | Within open 24-hour FEP window — customer initiated conversation | Free | LEAD-INIT-A, BOOKING-CONFIRM, MIX-PROMPT-A, POST-D0-A, POST-D0-B |
| Utility template | Outside FEP — transaction-related notification | $0.0205/conversation | POST-D0-UTIL (service complete + YES prompt) |
| Marketing template | Outside FEP — promotional or re-engagement | $0.0481/conversation | LEAD-F1-A, LEAD-F2-A, POST-REVIEW-A, POST-REFERRAL-A, REM-1-A through REM-5-A |

Template IDs and their triggers:

| Template ID | WA Name | Trigger | Type |
| :-: | :-: | :-: | :-: |
| LEAD-INIT-A | — | First inbound message from new contact | Service |
| LEAD-F1-A | kool_lead_followup_1 | L+18hr, no booking confirmed | Marketing |
| LEAD-F2-A | kool_lead_followup_2 | L+5D, no booking confirmed | Marketing |
| BOOKING-CONFIRM | kool_booking_confirm | Operator confirms slot | Service |
| MIX-PROMPT-A | — | Home team slot > 7 days | Service |
| POST-D0-UTIL | kool_service_complete | Job completed, outside FEP | Utility |
| POST-D0-A | — | Customer replies YES to POST-D0-UTIL | Service |
| POST-D0-B | — | After photo bundle completes | Service |
| POST-REVIEW-A | kool_review_request | C+1D, review not given | Marketing |
| POST-REFERRAL-A | kool_referral_request | C+3D | Marketing |
| REM-1-A | kool_reminder_90 | C+90D | Marketing |
| REM-2-A | kool_reminder_105 | C+105D, no response to REM-1-A | Marketing |
| REM-3-A | kool_reminder_180 | C+180D, 10% off 3+ units offer | Marketing |
| REM-4-A | kool_reminder_210 | C+210D, MD personal outreach, 12% off | Marketing |
| REM-5-A | kool_reminder_365 | C+365D, 15% off returning customer | Marketing |

**Delivery gap found 29 July 2026, not yet fixed:** every template marked "Marketing" above (`LEAD-F1-A`, `LEAD-F2-A`, `POST-REVIEW-A`, `POST-REFERRAL-A`, `REM-1-A` through `REM-5-A`) is sent by `module3.js` via `sendWhatsApp()` — a free-text/service-tier send — not via `sendWhatsAppTemplate()`. Free-text messages can only reach a customer within an open 24-hour customer service window (the FEP mentioned in 1.3). Meta's Cloud API will still return a `200` and a real `wamid` for a send outside that window — it does not reject at the API layer — so the send *looks* successful in `5_Message_Log` and the server console while silently never reaching the customer. This is exactly what happened in a live incident on 2026-07-29 (diagnosed via the new webhook status logging, 3.10.8) and will recur for any Marketing-tier reminder sent to a customer who hasn't messaged in the last 24 hours, which is the normal case for a proactive reminder. **Real fix, not yet done:** get these templates approved by Meta (blocked on the rejected display name, see 3.5) and switch these send calls to `sendWhatsAppTemplate()`, which works regardless of window state.

2.5 Module 3 — Automation Engine

Runs on a 15-minute timer via runSync in index.ts. Five independent blocks — **note the block numbers below match the code's own comments, but the code does not execute them in numeric order**; the actual source order is Block 1, 2, 4, 5, 3 (see 3.4 for the exact sequence):

Block 1: syncCalendarToJobs — pulls manual calendar events, creates Job rows

Block 2: detectAndMarkCompletedJobs — stamps Completed_At, updates Last_Job_Date, queues POST-D0-A draft

Block 3: runDailyReminderSweep — runs once/day at Sweep_Hour_SGT, generates reminder drafts into Module3_Queue (executes last in the actual file, despite the number)

Block 4: pollTechnicianSubmissions — scans Drive for new _SUBMIT_ files, routes fields to 2_Jobs/1_Contacts via 1_App_Config schema

Block 5 (new, 29 July 2026): recomputeContactTotals — recomputes `Total_Jobs`/`Total_Spend_SGD` for every contact from `2_Jobs`, batch-writing only changed cells (see 3.10.7)

Team_Schedule cache: 60-minute TTL. Changes to Team_Schedule take effect within 60 minutes — no restart needed.

Module3_AutoSend=FALSE: all drafts require operator approval — either replying `Q-NNN` in Telegram, or reviewing/editing/approving in the browser's Reminder Queue panel (see 1.6, 3.10).

Sweep gate is in-memory only (`sweepRanToday` in index.ts), not persisted to Sheets — it resets on every gateway restart. If a restart happens during the `Sweep_Hour_SGT` hour, the sweep can fire a second time that day on the next 15-minute tick. Check `Module3_Queue` for duplicate rows generated the same day if a restart happened during that window.

**Separate, confirmed-live duplicate-queue risk (29 July 2026):** the sweep's only duplicate-prevention is "is this Contact_ID + Template_ID pair already sitting in `Module3_Queue` right now" — it does **not** check `5_Message_Log`/send history. L-anchor templates (`LEAD-F1-A`, `LEAD-F2-A`) use a `>=` threshold (once eligible, always eligible — see 3.1's module3.js row), so if `Module3_Last_Run_Date` in `9_Settings` is ever manually cleared and the sweep re-run (e.g. for testing), it will re-queue an L-anchor draft for **every** contact who's already past that template's threshold and doesn't currently have one queued — including contacts who received and already had that draft approved days or weeks earlier. Confirmed live: a manual retest on 2026-07-29 unexpectedly re-queued `LEAD-F1-A` for 11 real contacts (KA-0003, KA-0010, KA-0012–0020) who almost certainly already received it. **Not yet fixed** — the correct fix is to also check `hasReceivedTemplate(contactId, templateId)` (already exists in `sheets.js`, reads `5_Message_Log`) before queueing an L-anchor draft, not just the current queue state. Until fixed: never manually clear `Module3_Last_Run_Date` without immediately reviewing every newly-queued item in the Reminder Queue panel before approving anything.

2.6 Booking Page (kool-pi.vercel.app/book)

Three-step mobile-first booking flow:

Step 1 — Customer enters name, WhatsApp number, address, postal code, service type, units

Step 2 — Calendar loads via GET /booking/slots — shows 14 days, greyed dates have no availability. Customer picks date then 30-minute start time.

Step 3 — Summary + WhatsApp button. Tapping opens WhatsApp with pre-filled structured message. Customer sends → FEP opens.

API endpoint: GET {OPENCLAW_URL}/booking/slots?postal=&service=&units=&phone=

Returns: zone, durationMins, price, isReturningCustomer, dates (14-day map with available flag and slot list)

Slot format: 30-minute increments within AM (9:00–12:00) and PM (13:00–18:00) blocks. Latest AM start: 11:00 for 60-min job.

Current OpenClaw URL: https://flatly-aviator-turf.ngrok-free.dev — changes on server restart. Update NEXT_PUBLIC_OPENCLAW_URL in Vercel.

Part 3 — Technical Annex

Written for an AI assistant or developer picking this up cold. Verify against live files before making changes — see 3.10.6 for why that verification step matters more than it might seem.

3.1 File Layout

CRM workspace: ~/.openclaw/workspace/crm/

| File | Lines | Responsibility |
| :-: | :-: | :-: |
| bot.js | 261 | Barrel file + core hub. Config constants (OPERATOR_TELEGRAM_ID, BOT_TOKEN, BLOCK_SIZE_MINS), sendTelegram() (now takes an optional `messageType` param), pendingApprovals map, getStagedSlots(), syncCalendarToJobs(). Re-exports all handlers from domain files, including handleQueueDiscard (new in v4). |
| crm.js | 1034 | Customer-facing handlers: handleInboundMessage, handleInfoCommand, handleOperatorApproval, handleQueueApproval (fixed in v4 — see 3.10.4), handleQueueDiscard (new in v4), isQueueApprovalText. Web booking message parser. YES reply detection (isPhotoYesReply, isProbablePhotoYesReply). handleSendPhotosCommand. |
| booking.js | 1067 | Slot finding and confirmation: handleBookingCommand (/b), handleConfirmSlot, handleConfirmBooking, handleMixYes, handleMixNo, handleCheckCal, handleCalInfo, normalizeInboxId. Both handleBookingCommand and handleConfirmSlot accept an optional `{ notifyFn, silent }` — the browser's booking panel (3.10) passes a no-op notifyFn so slot search/confirm don't also ping Telegram. |
| module3.js | 618 | Automation engine: runDailyReminderSweep, detectAndMarkCompletedJobs, pollTechnicianSubmissions (schema-driven via 1_App_Config). **Known gap** — its own auto-send branch (not the browser/Telegram approval path) still passes `entry.Contact_ID` straight to sendWhatsApp/sendTelegram, the same bug fixed in handleQueueApproval (3.10.4) — only relevant if Module3_AutoSend is ever set TRUE, and not yet fixed. **29 July 2026:** both draft-generation loops (C-anchor and L-anchor) now also pass a `customer_phone` var to `fillTemplate()` (aliasing `Phone`) since at least one live template references `{{customer_phone}}`, which was never populated before (3.10.9). `cleanQueueStaleAndExpired`'s L-anchor branch also independently gained a `daysSinceCreated`-based staleness check on the live server before this doc's last update — reconciled into this file, not a new change. |
| reports.js | 320 | Photo bundle delivery: assemblePhotoBundleSequence, sendPhotoBundleToCustomer, compilePostD0B. Fetches photos from Drive, uploads to Meta, sends in sequence. |
| templates.js | 302 | Meta WhatsApp template registry. getTemplateComponents() for registration, getSendComponents() for sending. All 10 registered templates defined here with buttons and params. |
| scheduler.js | 608 | Slot-finding engine. findAvailableSlots(), getZoneFromPostal(), getDurationMins(). _zoneDayCache has 60-min TTL. |
| sheets.js | 1065 | All Google Sheets reads/writes. Dynamic column lookup — reads headers at runtime. getAppConfig() reads 1_App_Config from tech workbook. appendSubmission(), updateSubmissionStatus() for tech app audit log. Module3_Queue helpers: getQueue, addToQueue, findQueueById, removeFromQueue, updateQueueDraftText (new in v4). **29 July 2026:** `fillTemplate()` now matches `{{key}}` case-insensitively (3.10.9); new `recomputeContactTotals()` replaces the old spreadsheet formula (3.10.7). |
| calendar.js | 238 | All Google Calendar reads/writes. buildDescription/parseDescription for structured event metadata — the browser's calendar job-card expansion (3.10) reuses parseDescription directly. |
| whatsapp.js | 392 | sendWhatsApp() (now takes an optional `messageType` param, default `'bot-resp'`), uploadWhatsAppMedia(), sendWhatsAppTemplate(), sendWhatsAppMedia(), sendWhatsAppInteractive(), registerWhatsAppTemplate(). All tokens from process.env via supervisord. |
| db.js | 186 | **New in v4.** SQLite (`sql.js`) wrapper backing the browser UI's message thread. Exports: insert, getMessagesByConversation, getMessagesSince, getUnreadCount, getThreadSummaries, markConversationRead. See 3.10.2 for schema. |
| broadcast.js | 26 | **New in v4.** Minimal in-memory pub-sub (`onUIMessage`, `broadcastToUI`) — currently has zero subscribers since the UI uses long-polling, not WebSocket (3.10.1 explains why); kept as the seam for a future real WebSocket upgrade with no other file needing to change. |
| ui.html | 1194 | **New in v4.** The entire browser CRM frontend — single file, vanilla JS/CSS, no build step, no framework. Served fresh from disk on every `GET /ui` request (no restart needed to edit it). **29 July 2026:** mobile-responsive layout added (3.10.10). |

Extension entry point: ~/.openclaw/workspace/.openclaw/extensions/koolaircon-crm/index.ts

Size: 2030 lines (was ~850 in v3) — the growth is almost entirely the browser UI's REST routes and the `runXCommand` extraction described in 3.10.3, plus (29 July 2026) Block 5 (3.10.7) and WhatsApp delivery-status webhook logging (3.10.8). Registers 11 Telegram commands, 2 event hooks, and the HTTP routes listed in 3.10.5, plus the 15-minute runSync timer.

3.2 Credentials & IDs

Note: do not share these publicly. Store in a password manager.

| Item | Value / Location |
| :-: | :-: |
| Google Sheets ID | 1YSU2zdeijOyp4KZYxav6ASoLLNst6IrPZ5Vo2lB05p4 |
| Tech App Workbook ID | 1Oa8szd_6Zy9lAkZHpwq_aH6zKGSUcAjlXjZsKOkW258 |
| Google Drive (code backup + deploy staging) | 0AD-hRMQ3c1ugUk9PVA (Shared Drive) |
| Service Account | openclawcrm@aircon-crm-499108.iam.gserviceaccount.com |
| Service Account Key | /home/ubuntu/.openclaw/workspace/.openclaw/secrets/gsheets-credentials.json |
| Operator Telegram ID | 126686924 |
| Telegram Bot | @JKaircon_bot |
| WhatsApp Phone Number ID | **Corrected 29 July 2026:** `1261834007009399` is the real, already-registered production number (WABA display number +65 8875 7334). `1148898708312929`, previously listed here as "test," is dead/legacy and unused anywhere in current code — confirmed via repo-wide grep. `whatsapp.js` still exports the legacy value as `PHONE_NUMBER_ID` (unused) alongside the real, module-private `WHATSAPP_PHONE_NUMBER_ID` actually used by every send function. |
| WhatsApp WABA ID | See WABA display number above (+65 8875 7334). The previously-listed `3874891512807457` was not re-verified this pass — confirm in WhatsApp Manager before relying on it. |
| WhatsApp display name | **Rejected by Meta as of 29 July 2026** — "Kool Aircon" violates Meta's Display Name Guidelines (WhatsApp Manager → Phone Numbers shows the rejection banner). Needs a compliant resubmission (matching the registered business/trading name) before Marketing-tier template submission can proceed — see 3.5, 3.7. |
| Meta Webhook Verify Token | In process.env.WHATSAPP_VERIFY_TOKEN (supervisord) |
| BOT_TOKEN | In process.env.BOT_TOKEN (supervisord) |
| WHATSAPP_ACCESS_TOKEN | In process.env.WHATSAPP_ACCESS_TOKEN (supervisord) |
| UI_PASSWORD | **New in v4.** In process.env.UI_PASSWORD (supervisord) — HTTP Basic Auth password for `/ui` and every `/api/*` route. If unset, those routes return 500 rather than silently allowing access. **Not scoped per-user** — anyone given this password has full read/write access to real customer data and can send messages as the business; there is no read-only or sandboxed mode. |
| OpenClaw Host | OVH container via MyClaw — no direct SSH |
| Gateway restart | supervisorctl -c /tmp/supervisord-openclaw.conf restart openclaw-gateway |
| ngrok URL (current) | https://flatly-aviator-turf.ngrok-free.dev (changes on restart) — also serves `/ui` |
| Vercel project | kool-pi.vercel.app — NEXT_PUBLIC_OPENCLAW_URL env var must match ngrok URL |
| Technician app | https://junkait.github.io/KoolAir- (GitHub Pages) |
| KoolAircon Jobs Drive folder | 1hxwi9RQGg9myRe-u9Rg6UdViHQ2wZDJJ |

**Credential rotation reminder (29 July 2026):** `WHATSAPP_ACCESS_TOKEN`, `BOT_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, and `UI_PASSWORD` were all pasted in plaintext into an AI chat session this same day (while sharing the supervisord config for debugging). Treat all four as exposed and rotate them — update the values, update the `environment=` line in `/tmp/supervisord-openclaw.conf`, restart the gateway — especially before giving `UI_PASSWORD` to anyone new.

3.3 Key Architecture Facts

Zero LLM calls on any operator command, webhook, background timer, or browser-UI path.

Only 3 external API endpoints: Telegram Bot API, Google Maps Distance Matrix, Meta Graph API. The browser UI adds zero new external dependencies — it talks only to this same OpenClaw process.

Channel routing: determined by contact.Source.includes("WhatsApp") — not by incoming channel parameter alone. Every browser route (`/api/send`, `/api/command`, `/api/booking/slots`, `/api/booking/confirm`, `/api/queue/approve`) uses this exact same check.

pendingApprovals map: in-memory, keyed by inbox ID. Does NOT survive gateway restart — operator must re-run /b and /confirm, whether from Telegram or the browser.

syncInFlight: module-level boolean in index.ts. Prevents concurrent runSync executions. Must be module-level, not inside runSync.

sweepRanToday: module-level string, in-memory only. Set BEFORE first await after hour gate to prevent concurrent sweeps. Resets on gateway restart — see 2.5 for the duplicate-sweep implication.

getSettings() TTL: 60 seconds. Safe to change 9_Settings without restart.

_zoneDayCache TTL: 60 minutes. Team_Schedule changes propagate within 60 minutes.

fillTemplate(): supports both {{param}} (Meta format) and [Param] (legacy) — backward compatible. **29 July 2026:** `{{param}}` matching is now case-insensitive (a template's literal `{{name}}` now matches a vars object's `Name` key) — previously case-sensitive, which meant several live templates rendered the placeholder text verbatim instead of the customer's name. A placeholder with no matching key at all (e.g. `{{review_link}}`, pending a `9_Settings` key — see 3.7) is still left untouched rather than blanked.

Booking page slot enumeration: 30-minute increments within AM/PM blocks. Deduplicated and sorted by startMins.

Browser UI message log is SQLite, not Sheets: `db.js` (sql.js/WASM, chosen over `better-sqlite3` because the deployment environment lacked a reliable node-gyp/C++ toolchain) is the only source for the browser's message thread and thread list. It does not replace `5_Message_Log` (Sheets) — both are written on every send/receive, for different consumers (Sheets = permanent audit trail across all channels historically; SQLite = fast real-time reads for the browser).

Browser UI uses long-polling, not WebSocket: `GET /api/updates?since=<ts>` is polled every 3 seconds. This was a deliberate downgrade from the original spec (see 3.10.1) after live-testing showed OpenClaw's core intercepts all WebSocket upgrade requests on the shared port before any plugin route runs, and the ngrok free tier only forwards one tunnel anyway. `broadcast.js` exists as the seam for a real WebSocket to attach to later without touching any other file.

3.4 runSync Timer Blocks

Fires every 15 minutes. Five independent try/catch blocks inside one try/finally that releases syncInFlight. **The table below is in actual source-code execution order** — the code's own inline comments number them 1/2/4/5/3 (not 1–5 sequentially); this table resolves that so the order is unambiguous:

| Order | Code's own label | Function | What it does |
| :-: | :-: | :-: | :-: |
| 1st | Block 1 | syncCalendarToJobs() | Creates Job rows from confirmed calendar events that have no job yet |
| 2nd | Block 2 | detectAndMarkCompletedJobs() | Stamps Completed_At, updates Last_Job_Date, queues POST-D0-A draft |
| 3rd | Block 4 | pollTechnicianSubmissions() | Scans Drive for _SUBMIT_ JSON files, routes fields to sheets via 1_App_Config |
| 4th (new, 29 July 2026) | Block 5 | recomputeContactTotals() | Recomputes Total_Jobs/Total_Spend_SGD per contact from 2_Jobs, writes only changed cells (3.10.7) |
| 5th (last) | Block 3 | runDailyReminderSweep() | Daily at Sweep_Hour_SGT — generates reminder drafts into Module3_Queue, purges old inbox |

3.5 WhatsApp Integration

Webhook: https://flatly-aviator-turf.ngrok-free.dev/webhook/whatsapp (auth: plugin, match: exact)

Subscribed field: messages

Inbound flow:

POST → isOperatorNumber check → customer branch → handleInboundMessage() → contact created → inbox created → operator notified (Telegram + logged for browser)

POST → isOperatorNumber → Q-NNN check → handleQueueApproval → else INBOX-NNN → handleOperatorApproval

New functions in whatsapp.js (v3, unchanged in v4 except the new optional `messageType` param on sendWhatsApp):

uploadWhatsAppMedia(buffer, mimeType, filename) — uploads to Meta media API, returns media ID

sendWhatsAppTemplate(to, templateName, params, headerMediaId) — sends approved template

sendWhatsAppMedia(to, type, mediaId, caption) — sends image/video in FEP window

sendWhatsAppInteractive(to, body, buttons) — sends reply button or CTA message

registerWhatsAppTemplate(name, bodyText) — submits template to Meta for approval

Template registration status: All 10 templates defined in templates.js. NOT yet submitted to Meta — blocked on live URLs for button links (kool.com.sg/book, /refer, /review) **and now also blocked on the rejected display name** (below) — Meta ties template submission eligibility to business verification/display-name status.

**Delivery-status webhook logging (added 29 July 2026, 3.10.8).** The webhook handler previously only ever read `payload.entry[0].changes[0].value.messages` (inbound customer text) and silently discarded every other payload shape, including Meta's async delivery-status callbacks (`value.statuses`: sent/delivered/read/failed, with an `errors` array on failure). It now logs each status event as `[whatsapp] status: id=... status=... recipient=... errors=...` — visible in the server log but **not yet correlated back to `5_Message_Log` or persisted anywhere structured**; that's a reasonable next step, not done in this pass.

**WhatsApp display name rejected by Meta (found 29 July 2026).** WhatsApp Manager → Phone Numbers shows: *"Your display name Kool Aircon was rejected... violates WhatsApp's Display Name Guidelines."* Needs a compliant resubmission via the Profile tab (matching the registered/legal business name) before template submission can proceed. Does not appear to block ordinary free-text (Service-tier) sends within an open FEP window — Meta's own Message delivery insights (WhatsApp Manager → Phone Numbers → Insights) showed real sent/delivered Service-tier traffic with $0 charges while the rejection was active.

**Confirmed live incident (29 July 2026) — read together with the Marketing-tier gap noted in 2.4.** Three Module3 reminder drafts were approved from the browser and each returned a real Meta message id (`wamid...`), logged as `Sent` in `5_Message_Log` — but none reached the test phone. Root cause: the last inbound message from that test number was over 24 hours old, so the FEP window was closed; Meta accepted the free-text send at the API layer (no error) but never delivered it. Confirmed fixed for the specific test case by re-sending after the test number sent a fresh "Hi" (reopening the window) — **the underlying architecture gap (2.4: Marketing-tier content sent as free text, not via approved templates) is not fixed**, since it depends on templates that aren't yet approvable (rejected display name, above).

3.6 Technician App Integration

Tech App Workbook: 1Oa8szd_6Zy9lAkZHpwq_aH6zKGSUcAjlXjZsKOkW258

| Tab | Purpose |
| :-: | :-: |
| 1_App_Config | Schema registry — defines every field the app shows, its input type, and which CRM column it maps to (CRM_Sheet + CRM_Column). Adding a row adds a field to the app with zero code change. |
| 3_Submissions | Audit log — every technician submission written here before CRM update. |

Current poller flow (pollTechnicianSubmissions):

Scans Drive KoolAircon Jobs folder for _SUBMIT_ JSON files (allDrives corpora)

Tracks processed files in 9_Settings.Tech_Processed_Submissions (comma-separated file IDs)

Reads 1_App_Config to route each field to 2_Jobs or 1_Contacts dynamically

Writes audit row to 3_Submissions

Fires detectAndMarkCompletedJobs() to queue POST-D0-A draft

Tech app upload: Technicians need Editor access to the KoolAircon Jobs Drive folder. Add each technician's Gmail to the folder as Editor.

3.7 Deferred Items & Testing Log

| Item | Status | Blocked by |
| :-: | :-: | :-: |
| Browser CRM UI (`/ui`) | **Built, live, end-to-end tested — including a real Reminder Queue approve-and-send that confirmed delivery once inside the FEP window.** | None — see the Marketing-tier delivery gap below for the real remaining risk. |
| Mobile-responsive `ui.html` layout | **Built and deployed 29 July 2026** (3.10.10). | None. |
| Marketing-tier Module3 reminders sent as free text, not approved templates | **Confirmed live production gap, not fixed** — see 2.4, 3.5. Root cause of a real delivery-failure incident on 2026-07-29. | Meta template approval, which is itself blocked on the display name rejection below. |
| WhatsApp display name "Kool Aircon" rejected by Meta | Not fixed | Resubmit a compliant name via WhatsApp Manager → Profile (see 3.5). |
| Module3_Queue L-anchor duplicate-requeue risk | Confirmed live, not fixed | Dedup only checks the current queue, not `5_Message_Log` — see 2.5. Fix: also check `hasReceivedTemplate()` before queueing an L-anchor draft. |
| Exposed credentials (WHATSAPP_ACCESS_TOKEN, BOT_TOKEN, WHATSAPP_VERIFY_TOKEN, UI_PASSWORD) | Not yet rotated | Pasted into a chat session 29 July 2026 (see 3.2) — rotate before any wider `/ui` sharing. |
| Test contacts left in production data (KA-0055–KA-0067, "Test ..." names) | Not yet cleaned up | Created during Reminder Queue/delivery testing on 2026-07-29; skews job counts/totals if left in `1_Contacts`. |
| `{{review_link}}` template placeholder | Intentionally left unfilled | Needs a new `Google_Review_Link` key in `9_Settings`, then wiring into module3.js's `fillTemplate()` calls (not done — deferred per explicit instruction). |
| module3.js auto-send Contact_ID bug | Known, not fixed | Only matters if Module3_AutoSend is ever set TRUE — see module3.js row in 3.1 and 3.10.4. |
| End-to-end WhatsApp template test | Not done | Templates not yet approved — doing partial test first |
| Meta template registration | Deferred | Live URLs needed: kool.com.sg/book, /refer, /review |
| Production Meta credentials | Deferred | Switch WA_Phone_Number_ID and WA_WABA_ID to production values in 9_Settings |
| Google Maps review link | Deferred | Google Maps listing not yet created |
| POST-D0-UTIL video header | Deferred | Need real dirty water video + Meta template approval |
| Photo bundle (YES flow) | Built, untested | Requires approved Meta number for media upload API |
| Cloudflare Tunnel (stable URL) | Deferred | Requires kool.com.sg domain purchase — also fixes `/ui`'s URL instability |
| Service report page | Deferred | Website access needed (kool.com.sg) |
| Tech app rebuild (dynamic form) | Deferred | After shadowing technicians + stable OpenClaw URL |
| ΔT measurement fields | Future phase | Equipment + training needed first |
| Sleep Better audit fields | Future phase | Equipment + training needed first |
| Referral credit mechanism | Deferred | Business decision on credit amount needed |
| Discount code system | Deferred | REM-3/4/5 reference discounts but no mechanism built |
| Booking page — kool.com.sg | Deferred | Currently on kool-pi.vercel.app. Move when domain accessible |

3.8 Known Bugs Fixed (v2 → v3)

In addition to all bugs fixed in v2, the following were fixed in the v3 session:

bot.js monolith split: was 2,723 lines in one file. Now a 250-line barrel re-exporting from crm.js, booking.js, module3.js.

Credentials in source code: BOT_TOKEN and WHATSAPP_ACCESS_TOKEN were hardcoded fallbacks. Now exclusively from process.env via supervisord environment= lines.

_zoneDayCache never invalidated: Team_Schedule changes required a gateway restart. Fixed with 60-minute TTL.

crm.js missing imports: parseHHMM, sgtDateAtMinutes, ZONE_COLOR, calCreateEvent used but not imported after the split. Fixed before first restart.

/booking/slots returning HTML: auth: "plugin" and match: "exact" missing — OpenClaw frontend router was intercepting the route.

/booking/slots res.status not a function: handler used Express-style response API. Fixed to raw Node.js http.ServerResponse with sendJson helper.

/booking/slots CORS preflight missing headers: OPTIONS handler only returned Access-Control-Allow-Origin. Fixed to include Allow-Methods and Allow-Headers with 204 response.

Module3_Last_Run_Date duplicate: two rows in 9_Settings. Cleaned up.

URL_Our_Service vs URL_Our_Services naming inconsistency: old key cleared, standardised to URL_Our_Services.

3.9 Next Session Starting Point

Immediate priority (updated 29 July 2026): the browser CRM UI is now end-to-end tested and the mobile layout is live, so the top of the list has shifted to the delivery-reliability gap found this session — that's the thing most likely to silently cost the business real messages if left alone.

Next session checklist:

1. **Fix the WhatsApp display name rejection** — resubmit a compliant name via WhatsApp Manager → Profile. Blocks everything below.

2. **Get the 10 templates approved by Meta** (blocked on #1), then **switch `module3.js`'s Marketing-tier sends (`LEAD-F1-A`, `LEAD-F2-A`, `POST-REVIEW-A`, `POST-REFERRAL-A`, `REM-1-A`–`REM-5-A`) from `sendWhatsApp()` to `sendWhatsAppTemplate()`** — this is the actual fix for the 2026-07-29 delivery-failure incident, not just a one-off retest with the window reopened.

3. **Fix the Module3_Queue L-anchor duplicate-requeue risk** — have the sweep also check `hasReceivedTemplate()` (5_Message_Log) before queueing an L-anchor draft, not just current queue state.

4. **Rotate WHATSAPP_ACCESS_TOKEN, BOT_TOKEN, WHATSAPP_VERIFY_TOKEN, UI_PASSWORD** (exposed in a chat session 29 July 2026) before sharing `/ui` access with anyone new.

5. **Clean up test data**: delete the test contacts (KA-0055–KA-0067) from `1_Contacts` and confirm no stray `LEAD-F1-A`/other queue entries remain from testing.

6. Add a `Google_Review_Link` key to `9_Settings` and wire `{{review_link}}` into module3.js's `fillTemplate()` calls once ready.

7. Decide whether to fix the module3.js auto-send Contact_ID bug now or leave it (it's dormant while Module3_AutoSend=FALSE).

8. Buy kool.com.sg (or koolaircon.com)

9. Point DNS to Cloudflare

10. Set up Cloudflare Tunnel → api.kool.com.sg → OVH server port 18789 (this also fixes `/ui`'s URL instability — no more re-sharing a new link after every ngrok restart)

11. Update NEXT_PUBLIC_OPENCLAW_URL in Vercel to new stable URL

12. Update webhook URL in Meta console

13. Set up redirects: kool.com.sg/book, /refer, /review, /report

14. Update URL_* settings in 9_Settings

15. Run full end-to-end WhatsApp test (once templates are approved and switched over)

16. Shadow technicians → update 1_App_Config and rebuild tech app

Part 3.10 — Browser CRM UI Technical Reference (new in v4)

3.10.1 Why long-polling instead of WebSocket

The original design spec called for a WebSocket push channel. Before building it, a raw WebSocket-upgrade `curl` was sent against the live server, once to a nonexistent path and once to a real registered plugin route — both returned an identical `101 Switching Protocols` handshake with the same OpenClaw-internal payload shape. That proved OpenClaw's core intercepts every WebSocket upgrade on the shared port unconditionally, before any plugin's `registerHttpRoute` handler ever runs — a real WebSocket route is not reachable this way. A second port was also ruled out since the ngrok free tier only forwards one tunnel. Decision: `GET /api/updates?since=<timestamp>` long-polled every 3 seconds from the browser, using the server's own `now` in the response as the client's next `since` bookmark (avoids client/server clock-skew drift). `crm/broadcast.js` still exists as the fan-out seam a future real WebSocket would attach to — Phase 2 of the original build wired every notify-worthy event through `broadcastToUI()` from day one specifically so that whenever a WebSocket does get built, zero other files need to change.

3.10.2 SQLite schema (`crm/db.js`, `sql.js`/WASM)

| Field | Type | Notes |
| :-: | :-: | :-: |
| id | INTEGER | Primary key, autoincrement |
| conversation_id | TEXT | The contact's Channel_Contact_ID (phone number or Telegram user id) |
| channel | TEXT | `telegram` or `whatsapp` |
| direction | TEXT | `inbound` or `outbound` |
| message_type | TEXT | `direct` (Path A plain-text send), `bot-cmd` (operator's own /command text), `bot-resp` (a command's or automation's result — rendered as a centred system bubble if it starts with ⚠️/❌), `bot-response` legacy alias |
| text | TEXT | Message content |
| timestamp | INTEGER | Unix ms — always server clock, never client clock |
| sender | TEXT | Contact_ID/conversation_id or `operator` |
| read | INTEGER | 0 = unread, 1 = read |

Exports: `insert`, `getMessagesByConversation`, `getMessagesSince`, `getUnreadCount`, `getThreadSummaries`, `markConversationRead`.

3.10.3 The `runXCommand` extraction

Every Telegram command's arg-parsing regex and dispatch logic used to live inline inside its `registerCommand({ ... async handler(ctx) {...} })` call in index.ts. To let the browser's compose box run the exact same commands without a second, independently-drifting copy of the parsing logic, each command body was extracted into a standalone `async function runXCommand(argsString)` (e.g. `runInfoCommand`, `runConfirmCommand`, `runBCommand`, `runInCommand`, `runCalinfoCommand`, `runMixyesCommand`, `runMixnoCommand`, `runCheckCalCommand`, `runConfirmBCommand`, `runSendphotosCommand`) returning the same `{ text, inboxId? }` shape the Telegram registration already expected. The Telegram `registerCommand` handlers now just call the matching `runXCommand`; `POST /api/command` (3.10.5) dispatches to the identical function via a `PATH_B_RUNNERS` lookup table. This was a pure refactor — verified by diffing that Telegram's behavior was byte-identical before and after.

3.10.4 The Module3_Queue Contact_ID bug (found and fixed in v4)

`Module3_Queue.Contact_ID` holds the internal `KA-XXXX` contact id, not a phone/Telegram id (see 2.3's note). `handleQueueApproval` (crm.js) and `module3.js`'s own auto-send branch both used to pass `entry.Contact_ID` straight into `sendWhatsApp`/`sendTelegram`, which do zero id resolution themselves and just use whatever they're given as the literal recipient. That means every approved Module3 draft — via the Telegram `Q-NNN` reply, which existed well before the browser UI — was almost certainly failing to deliver, silently, for as long as this bug existed. Fixed in `handleQueueApproval` by resolving `contacts.find(c => c.Contact_ID === entry.Contact_ID)?.Channel_Contact_ID` before sending. **`module3.js`'s separate auto-send call sites have the identical bug and are not yet fixed** — dormant only because `Module3_AutoSend` defaults to FALSE (1.5); flagged in 3.1 and 3.7 as a known follow-up, not touched by this pass to keep scope contained.

While fixing this, `handleQueueApproval`'s entry lookup also moved from a straight suffix match (`Queue_ID.endsWith('-' + seqNum)`) to an exact-match-first strategy: `queue.find(q => q.Queue_ID === seqNum) || queue.find(q => q.Queue_ID.endsWith('-' + seqNum))`. Telegram's typed 3-digit form (`Q-004`) never exact-matches a full `Queue_ID` (`Q-20260728-004`), so it falls through to the same suffix match unchanged; the browser always has the full id from `GET /api/queue` and uses the exact match. `handleQueueApproval` and the new `handleQueueDiscard` both now return `{ success, message }` in addition to calling `notifyFn`, so the HTTP routes below don't have to sniff an emoji prefix to know whether a send worked.

3.10.5 Full HTTP route list (index.ts, all `auth: 'plugin', match: 'exact'`)

| Route | Method | Auth | Purpose |
| :-: | :-: | :-: | :-: |
| /webhook/whatsapp | GET, POST | plugin | Meta webhook verification + inbound WhatsApp events (pre-existing) |
| /booking/slots | GET, OPTIONS | plugin, CORS `*` | Public marketing-site slot search (pre-existing, unrelated to `/ui`) |
| /ui | GET | Basic (UI_PASSWORD) | Serves `crm/ui.html` fresh from disk on every request |
| /api/updates | GET | Basic | Long-poll: `?since=<ts>` → `{ messages, now }` |
| /api/threads | GET | Basic | Thread list, derived from SQLite + 1_Contacts |
| /api/messages | GET | Basic | `?conversationId=` or `?contactId=` → message history, marks read |
| /api/customer | GET, POST | Basic | GET: contact + job history + household flags + property. POST: save Address/Postal/Phone (whitelisted 3 fields) |
| /api/queue | GET | Basic | Module3_Queue rows, joined to contact names |
| /api/queue/edit | POST | Basic | `{ queueId, draftText }` → save without sending |
| /api/queue/discard | POST | Basic | `{ queueId }` → remove without sending |
| /api/queue/approve | POST | Basic | `{ queueId, contactId, draftText }` → save current text, then send + remove + cross-post a system bubble into that customer's thread |
| /api/calendar | GET | Basic | `?date=` → that day's events across every active team's calendar, with `meta` parsed from each event's description |
| /api/send | POST | Basic | Path A — plain text send, logs `message_type: 'direct'` |
| /api/booking/slots | POST | Basic | Structured service+units search — calls handleBookingCommand with a silent notifyFn |
| /api/booking/confirm | POST | Basic | `{ inboxId, choice }` — calls handleConfirmSlot with a silent notifyFn |
| /api/command | POST | Basic | Path B — dispatches to the matching `runXCommand` (3.10.3), auto-resolving/prepending the INBOX id |

3.10.6 Deploy pattern and its sharp edge

Every change lands via a hash-gated whole-file-replace script: compute sha256 of the new file and an expected pre-change baseline hash, compare against the live file before writing — `[SKIP]` if already applied, `[ABORT]` if the live file matches neither (drift), backup-then-write-then-reverify if it matches the expected baseline. This has repeatedly caught real drift between what git/the Shared Drive thinks is live and what's actually running — see the `crm.js`/`sheets.js` baseline mismatch during the v4 deploy (module3.js's `force`-parameter gap on `handleSendPhotosCommand` and a stray trailing blank line, respectively — both harmless once diffed directly against the live file, but the deploy script correctly refused to apply blind). **Lesson, repeated from v3: a git commit — or even a Shared Drive upload — being "reconciled" does not mean it was actually deployed. Confirm hashes against the live file, every time, before assuming a baseline.**

**29 July 2026 — this happened again, twice, in one session, and both times were false alarms once diffed.** (1) `module3.js`'s expected baseline hash didn't match the live file — investigation showed the *only* real difference was two separator comments one dash character shorter and a missing trailing blank line (an artifact of round-tripping the file through a base64 Drive upload/decode), plus the two intended `customer_phone` additions — safe to apply directly once diffed, no hash-gate needed for that specific case. (2) A live `module3.js` bug (`daysSinceCreated is not defined` — a leftover variable name from a different function, copy-pasted into a log line inside `runDailyReminderSweep`'s L-anchor loop where only `hoursSinceCreated` is actually in scope) was hotfixed directly on the server with `sed`, live, before this doc's fix could be prepared and deployed through the normal pipeline — then reconciled back into this repo afterward. **Reinforces the same lesson**: the live file is the only source of truth; git/Drive is downstream of it, not the other way around, and a hash mismatch is a signal to diff, not necessarily to panic or force.

3.10.7 recomputeContactTotals() (new, 29 July 2026)

Replaces a dragged-down spreadsheet formula in `1_Contacts`' `Total_Jobs`/`Total_Spend_SGD` columns that was silently inflating the sheet to 1000+ rows (a formula's mere presence in a cell defeated the "first truly empty row in column A" scan `appendRow()` uses elsewhere to find where to write a new contact). `sheets.js`'s new `recomputeContactTotals()` reads all of `2_Jobs` and `1_Contacts` once, sums job count and `Amount_SGD` per `Contact_ID` in memory, and batch-writes only the cells whose value actually changed. Runs as Block 5 of the 15-minute `runSync` timer (3.4). **Prerequisite the operator must do manually, once**: clear the existing formula out of those two columns in the Google Sheet UI — the code does not (and should not) overwrite a formula-bearing cell automatically, since Sheets re-evaluates formulas on every recalculation regardless of what the API just wrote.

3.10.8 WhatsApp delivery-status webhook logging (new, 29 July 2026)

Meta's WhatsApp webhook multiplexes two unrelated payload shapes onto the same `POST /webhook/whatsapp`: inbound customer messages (`value.messages`) and outbound delivery-status callbacks (`value.statuses` — `sent`/`delivered`/`read`/`failed`, with an `errors` array when `failed`). The handler previously only ever read `messages` and treated everything else as a no-op (`"webhook POST received (no actionable message)"`). It now also parses `statuses` and logs `[whatsapp] status: id=<wamid> status=<...> recipient=<...> errors=<...>` for each one — purely additive, no change to the existing inbound-message handling. This was the direct diagnostic tool that confirmed the 2026-07-29 delivery incident (3.5): the webhook was receiving status callbacks the whole time, just discarding them silently. **Not yet done**: correlating a status event back to its `5_Message_Log` row (would need the `wamid` returned by `sendWhatsApp()` to be stored against the log row at send time — it currently isn't).

3.10.9 fillTemplate() case-insensitivity + customer_phone var (new, 29 July 2026)

Two related template-rendering bugs found while investigating why a live reminder rendered as literal `"Hi {{name}}, hope the aircon is running well."` instead of the customer's name:

- **Case sensitivity**: `fillTemplate(text, vars)` used to do `text.replaceAll('{{' + key + '}}', value)` for each key in `vars` — an exact-case string replace. Every C-anchor/L-anchor draft passes `Name` (capital N) as the vars key, but the actual template text in `4_Templates` uses lowercase `{{name}}`, so the two never matched and the placeholder went out unfilled. Fixed by matching `{{key}}` via a single case-insensitive regex pass (`/\{\{\s*(\w+)\s*\}\}/g`, lower-cased on both sides before comparing) — a placeholder with no matching key at all (case-insensitively) is left untouched, not blanked, so an unwired placeholder like `{{review_link}}` still visibly signals "this isn't wired up yet" rather than silently disappearing. The legacy `[Key]` bracket form is untouched — still an exact-case literal replace, matching its pre-existing behavior.
- **customer_phone**: at least one live template references `{{customer_phone}}`, but neither of `module3.js`'s two draft-generation loops (C-anchor, L-anchor) ever passed a `customer_phone` key — only `Phone`. Both loops now also pass `customer_phone: contact.Phone || ''` alongside the existing `Phone` key.
- **review_link deliberately not fixed** in this pass — no `{{review_link}}` value exists yet anywhere in the system. Confirmed with the operator: this should come from a new `9_Settings` key (e.g. `Google_Review_Link`) once the business has a real Google review link to point to, not be hardcoded into module3.js. Tracked in 3.7/3.9.

3.10.10 Mobile-responsive layout (new, 29 July 2026)

Added directly to `ui.html` (built in a separate session to avoid overloading this one, then reconciled and deployed through the same hash-gated pipeline as everything else — see 3.10.6). A single `@media (max-width: 768px)` block plus a handful of new small elements (`#thread-help-btn`, `#chat-back-btn`, `#cal-close-btn`, `#queue-close-btn`) that only render at mobile widths:

- Below 768px, the thread list and chat panel become full-width single-screen views toggled by a `chat-active` class on `<body>` — opening a conversation hides the thread list and shows the chat panel; a new back button (←) in the chat header reverses that.
- The calendar and Reminder Queue panels become full-screen overlays (`position: fixed`, full viewport) instead of fixed-width side columns, each with a close button (✕).
- Form inputs are bumped to `font-size: 16px` at mobile widths specifically to stop iOS Safari's automatic zoom-on-focus behavior.
- No backend/route changes — purely a CSS/HTML/JS addition to the existing single-file frontend. No gateway restart needed to deploy it, since `GET /ui` already reads `ui.html` fresh from disk on every request (3.1).
