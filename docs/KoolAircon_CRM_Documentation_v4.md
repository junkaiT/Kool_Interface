KoolAircon CRM

System Documentation

Version 4.0 | July 2026 | KoolAircon Pte Ltd

This document replaces v3 (17 July 2026). Major addition: the browser CRM interface (`/ui`) — a WhatsApp-Web-style operator dashboard built across ten phases on top of the existing Telegram-bot backend, adding thread list, chat panel, customer-info editing, calendar/booking panel, and a Reminder Queue approval UI for Module 3 drafts. Telegram remains fully functional as a fallback at all times; nothing about the existing bot command logic changed except the extraction described in Part 3.10.

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

2.5 Module 3 — Automation Engine

Runs on a 15-minute timer via runSync in index.ts. Four independent blocks:

Block 1: syncCalendarToJobs — pulls manual calendar events, creates Job rows

Block 2: detectAndMarkCompletedJobs — stamps Completed_At, updates Last_Job_Date, queues POST-D0-A draft

Block 3: pollTechnicianSubmissions — scans Drive for new _SUBMIT_ files, routes fields to 2_Jobs/1_Contacts via 1_App_Config schema

Block 4: runDailyReminderSweep — runs once/day at Sweep_Hour_SGT, generates reminder drafts into Module3_Queue

Team_Schedule cache: 60-minute TTL. Changes to Team_Schedule take effect within 60 minutes — no restart needed.

Module3_AutoSend=FALSE: all drafts require operator approval — either replying `Q-NNN` in Telegram, or reviewing/editing/approving in the browser's Reminder Queue panel (see 1.6, 3.10).

Sweep gate is in-memory only (`sweepRanToday` in index.ts), not persisted to Sheets — it resets on every gateway restart. If a restart happens during the `Sweep_Hour_SGT` hour, the sweep can fire a second time that day on the next 15-minute tick. Check `Module3_Queue` for duplicate rows generated the same day if a restart happened during that window.

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
| module3.js | 616 | Automation engine: runDailyReminderSweep, detectAndMarkCompletedJobs, pollTechnicianSubmissions (schema-driven via 1_App_Config). **Known gap** — its own auto-send branch (not the browser/Telegram approval path) still passes `entry.Contact_ID` straight to sendWhatsApp/sendTelegram, the same bug fixed in handleQueueApproval (3.10.4) — only relevant if Module3_AutoSend is ever set TRUE, and not yet fixed. |
| reports.js | 320 | Photo bundle delivery: assemblePhotoBundleSequence, sendPhotoBundleToCustomer, compilePostD0B. Fetches photos from Drive, uploads to Meta, sends in sequence. |
| templates.js | 302 | Meta WhatsApp template registry. getTemplateComponents() for registration, getSendComponents() for sending. All 10 registered templates defined here with buttons and params. |
| scheduler.js | 608 | Slot-finding engine. findAvailableSlots(), getZoneFromPostal(), getDurationMins(). _zoneDayCache has 60-min TTL. |
| sheets.js | 992 | All Google Sheets reads/writes. Dynamic column lookup — reads headers at runtime. getAppConfig() reads 1_App_Config from tech workbook. appendSubmission(), updateSubmissionStatus() for tech app audit log. Module3_Queue helpers: getQueue, addToQueue, findQueueById, removeFromQueue, updateQueueDraftText (new in v4). |
| calendar.js | 238 | All Google Calendar reads/writes. buildDescription/parseDescription for structured event metadata — the browser's calendar job-card expansion (3.10) reuses parseDescription directly. |
| whatsapp.js | 392 | sendWhatsApp() (now takes an optional `messageType` param, default `'bot-resp'`), uploadWhatsAppMedia(), sendWhatsAppTemplate(), sendWhatsAppMedia(), sendWhatsAppInteractive(), registerWhatsAppTemplate(). All tokens from process.env via supervisord. |
| db.js | 186 | **New in v4.** SQLite (`sql.js`) wrapper backing the browser UI's message thread. Exports: insert, getMessagesByConversation, getMessagesSince, getUnreadCount, getThreadSummaries, markConversationRead. See 3.10.2 for schema. |
| broadcast.js | 26 | **New in v4.** Minimal in-memory pub-sub (`onUIMessage`, `broadcastToUI`) — currently has zero subscribers since the UI uses long-polling, not WebSocket (3.10.1 explains why); kept as the seam for a future real WebSocket upgrade with no other file needing to change. |
| ui.html | 1131 | **New in v4.** The entire browser CRM frontend — single file, vanilla JS/CSS, no build step, no framework. Served fresh from disk on every `GET /ui` request (no restart needed to edit it). |

Extension entry point: ~/.openclaw/workspace/.openclaw/extensions/koolaircon-crm/index.ts

Size: 1995 lines (was ~850 in v3) — the growth is almost entirely the browser UI's REST routes and the `runXCommand` extraction described in 3.10.3. Registers 11 Telegram commands, 2 event hooks, and the HTTP routes listed in 3.10.5, plus the 15-minute runSync timer.

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
| WhatsApp Phone Number ID | 1148898708312929 (test) |
| WhatsApp WABA ID | 3874891512807457 (test) |
| WhatsApp Test Number | +1 (555) 670-8135 |
| Meta Webhook Verify Token | In process.env.WHATSAPP_VERIFY_TOKEN (supervisord) |
| BOT_TOKEN | In process.env.BOT_TOKEN (supervisord) |
| WHATSAPP_ACCESS_TOKEN | In process.env.WHATSAPP_ACCESS_TOKEN (supervisord) |
| UI_PASSWORD | **New in v4.** In process.env.UI_PASSWORD (supervisord) — HTTP Basic Auth password for `/ui` and every `/api/*` route. If unset, those routes return 500 rather than silently allowing access. |
| OpenClaw Host | OVH container via MyClaw — no direct SSH |
| Gateway restart | supervisorctl -c /tmp/supervisord-openclaw.conf restart openclaw-gateway |
| ngrok URL (current) | https://flatly-aviator-turf.ngrok-free.dev (changes on restart) — also serves `/ui` |
| Vercel project | kool-pi.vercel.app — NEXT_PUBLIC_OPENCLAW_URL env var must match ngrok URL |
| Technician app | https://junkait.github.io/KoolAir- (GitHub Pages) |
| KoolAircon Jobs Drive folder | 1hxwi9RQGg9myRe-u9Rg6UdViHQ2wZDJJ |

3.3 Key Architecture Facts

Zero LLM calls on any operator command, webhook, background timer, or browser-UI path.

Only 3 external API endpoints: Telegram Bot API, Google Maps Distance Matrix, Meta Graph API. The browser UI adds zero new external dependencies — it talks only to this same OpenClaw process.

Channel routing: determined by contact.Source.includes("WhatsApp") — not by incoming channel parameter alone. Every browser route (`/api/send`, `/api/command`, `/api/booking/slots`, `/api/booking/confirm`, `/api/queue/approve`) uses this exact same check.

pendingApprovals map: in-memory, keyed by inbox ID. Does NOT survive gateway restart — operator must re-run /b and /confirm, whether from Telegram or the browser.

syncInFlight: module-level boolean in index.ts. Prevents concurrent runSync executions. Must be module-level, not inside runSync.

sweepRanToday: module-level string, in-memory only. Set BEFORE first await after hour gate to prevent concurrent sweeps. Resets on gateway restart — see 2.5 for the duplicate-sweep implication.

getSettings() TTL: 60 seconds. Safe to change 9_Settings without restart.

_zoneDayCache TTL: 60 minutes. Team_Schedule changes propagate within 60 minutes.

fillTemplate(): supports both {{param}} (Meta format) and [Param] (legacy) — backward compatible.

Booking page slot enumeration: 30-minute increments within AM/PM blocks. Deduplicated and sorted by startMins.

Browser UI message log is SQLite, not Sheets: `db.js` (sql.js/WASM, chosen over `better-sqlite3` because the deployment environment lacked a reliable node-gyp/C++ toolchain) is the only source for the browser's message thread and thread list. It does not replace `5_Message_Log` (Sheets) — both are written on every send/receive, for different consumers (Sheets = permanent audit trail across all channels historically; SQLite = fast real-time reads for the browser).

Browser UI uses long-polling, not WebSocket: `GET /api/updates?since=<ts>` is polled every 3 seconds. This was a deliberate downgrade from the original spec (see 3.10.1) after live-testing showed OpenClaw's core intercepts all WebSocket upgrade requests on the shared port before any plugin route runs, and the ngrok free tier only forwards one tunnel anyway. `broadcast.js` exists as the seam for a real WebSocket to attach to later without touching any other file.

3.4 runSync Timer Blocks

Fires every 15 minutes. Four independent try/catch blocks inside one try/finally that releases syncInFlight:

| Block | Function | What it does |
| :-: | :-: | :-: |
| 1 | syncCalendarToJobs() | Creates Job rows from confirmed calendar events that have no job yet |
| 2 | detectAndMarkCompletedJobs() | Stamps Completed_At, updates Last_Job_Date, queues POST-D0-A draft |
| 3 | pollTechnicianSubmissions() | Scans Drive for _SUBMIT_ JSON files, routes fields to sheets via 1_App_Config |
| 4 | runDailyReminderSweep() | Daily at Sweep_Hour_SGT — generates reminder drafts into Module3_Queue, purges old inbox |

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

Template registration status: All 10 templates defined in templates.js. NOT yet submitted to Meta — blocked on live URLs for button links (kool.com.sg/book, /refer, /review).

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
| Browser CRM UI (`/ui`) | **Built, live — v4.** Not yet end-to-end tested by the operator. | Next task: click through every panel against real data, including a real approve-and-send from the Reminder Queue. |
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

Immediate priority: end-to-end test the browser CRM UI against real data (thread list, customer edit, calendar/booking panel, and — carefully, since it's a real send — the Reminder Queue approve flow), then continue the pre-existing domain/Meta checklist below.

Next session checklist:

1. Click through every browser CRM panel against real conversations and confirm nothing silently breaks (no formal test suite exists — this is manual verification).

2. Decide whether to fix the module3.js auto-send Contact_ID bug now or leave it (it's dormant while Module3_AutoSend=FALSE).

3. Buy kool.com.sg (or koolaircon.com)

4. Point DNS to Cloudflare

5. Set up Cloudflare Tunnel → api.kool.com.sg → OVH server port 18789 (this also fixes `/ui`'s URL instability — no more re-sharing a new link after every ngrok restart)

6. Update NEXT_PUBLIC_OPENCLAW_URL in Vercel to new stable URL

7. Update webhook URL in Meta console

8. Set up redirects: kool.com.sg/book, /refer, /review, /report

9. Update URL_* settings in 9_Settings

10. Submit all 10 templates to Meta via registerWhatsAppTemplate()

11. Run full end-to-end WhatsApp test

12. Shadow technicians → update 1_App_Config and rebuild tech app

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
