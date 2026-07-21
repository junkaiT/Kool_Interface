KoolAircon CRM

System Documentation

Version 3.0 | July 2026 | KoolAircon Pte Ltd

This document replaces v2 (2 July 2026). Major additions: bot.js split into domain files, WhatsApp template system (templates.js, reports.js), booking page (Vercel), technician app integration, photo bundle delivery flow, and full message template library.

Three parts: Part 1 — Operator quick reference. Part 2 — How the system works. Part 3 — Technical annex for rebuilding.

Part 1 — Operator Quick Reference

All commands are typed to @JKaircon_bot on Telegram. Only the registered operator (ID 126686924) can run them.

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
| Q-NNN | Q-001 | Approve and send a Module 3 queued draft message. |
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
| Sweep_Hour_SGT | 8 | Hour (SGT, 24hr) when daily reminder sweep runs. |
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
| ngrok | Exposes OpenClaw to internet for Meta webhooks. URL changes on restart. | Live (free tier) |
| Vercel (kool-pi.vercel.app) | Hosts booking page frontend | Live |
| Google Drive | Technician app photo storage, code backup | Live |
| GitHub Pages | Hosts technician app (index.html) | Live |
| Cloudflare Tunnel | Planned replacement for ngrok — needs kool.com.sg domain first | Deferred |
| Web UI (operator dashboard) | Planned browser-based operator interface | Deferred |

2.2 Dual-Channel Architecture

| | Customer on WhatsApp | Customer on Telegram |
| :-: | :-: | :-: |
| Inbound path | POST /webhook/whatsapp → handleInboundMessage() | before_agent_reply hook → handleInboundMessage() |
| Operator notified | Telegram (always) | Telegram (always) |
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
| Team_Schedule | Per-team per-day zone coverage | Team_ID, Day, Primary_Zone, Overflow_Zone — requires restart after edits |
| Module3_Queue | Pending draft messages | Queue_ID, Contact_ID, Template_ID, Channel, Draft_Text — deleted on send or after 14 days |

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

Block 4: runDailyReminderSweep — runs once/day at Sweep_Hour_SGT, generates reminder drafts, sends Q-NNN list to operator

Team_Schedule cache: 60-minute TTL. Changes to Team_Schedule take effect within 60 minutes — no restart needed (fixed in v3).

Module3_AutoSend=FALSE: all drafts require Q-NNN operator approval.

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

Written for an AI assistant or developer picking this up cold. Verify against live files before making changes.

3.1 File Layout

CRM workspace: ~/.openclaw/workspace/crm/

| File | Lines | Responsibility |
| :-: | :-: | :-: |
| bot.js | ~250 | Barrel file + core hub. Config constants (OPERATOR_TELEGRAM_ID, BOT_TOKEN, BLOCK_SIZE_MINS), sendTelegram(), pendingApprovals map, getStagedSlots(). Re-exports all handlers from domain files. |
| crm.js | ~780 | Customer-facing handlers: handleInboundMessage, handleInfoCommand, handleOperatorApproval, handleQueueApproval, isQueueApprovalText. Web booking message parser. YES reply detection (isPhotoYesReply, isProbablePhotoYesReply). handleSendPhotosCommand. |
| booking.js | ~1030 | Slot finding and confirmation: handleBookingCommand (/b), handleConfirmSlot, handleConfirmBooking, handleMixYes, handleMixNo, handleCheckCal, handleCalInfo, normalizeInboxId. |
| module3.js | ~550 | Automation engine: runDailyReminderSweep, detectAndMarkCompletedJobs, cleanQueueStaleAndExpired, pollTechnicianSubmissions (schema-driven via 1_App_Config). |
| reports.js | ~320 | Photo bundle delivery: assemblePhotoBundleSequence, sendPhotoBundleToCustomer, compilePostD0B. Fetches photos from Drive, uploads to Meta, sends in sequence. |
| templates.js | ~302 | Meta WhatsApp template registry. getTemplateComponents() for registration, getSendComponents() for sending. All 10 registered templates defined here with buttons and params. |
| scheduler.js | ~600+ | Slot-finding engine. findAvailableSlots(), getZoneFromPostal(), getDurationMins(). _zoneDayCache has 60-min TTL (fixed in v3). |
| sheets.js | ~800+ | All Google Sheets reads/writes. Dynamic column lookup — reads headers at runtime. getAppConfig() reads 1_App_Config from tech workbook. appendSubmission(), updateSubmissionStatus() for tech app audit log. |
| calendar.js | ~238 | All Google Calendar reads/writes. buildDescription/parseDescription for structured event metadata. |
| whatsapp.js | ~200+ | sendWhatsApp() (plain text), uploadWhatsAppMedia(), sendWhatsAppTemplate(), sendWhatsAppMedia(), sendWhatsAppInteractive(), registerWhatsAppTemplate(). All tokens from process.env via supervisord. |

Extension entry point: ~/.openclaw/workspace/.openclaw/extensions/koolaircon-crm/index.ts

Size: ~850 lines. Registers 11 commands, 2 event hooks, 2 HTTP routes (/webhook/whatsapp, /booking/slots), and the 15-minute runSync timer.

3.2 Credentials & IDs

Note: do not share these publicly. Store in a password manager.

| Item | Value / Location |
| :-: | :-: |
| Google Sheets ID | 1YSU2zdeijOyp4KZYxav6ASoLLNst6IrPZ5Vo2lB05p4 |
| Tech App Workbook ID | 1Oa8szd_6Zy9lAkZHpwq_aH6zKGSUcAjlXjZsKOkW258 |
| Google Drive (code backup) | 0AD-hRMQ3c1ugUk9PVA (Shared Drive) |
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
| OpenClaw Host | OVH container via MyClaw — no direct SSH |
| Gateway restart | supervisorctl -c /tmp/supervisord-openclaw.conf restart openclaw-gateway |
| ngrok URL (current) | https://flatly-aviator-turf.ngrok-free.dev (changes on restart) |
| Vercel project | kool-pi.vercel.app — NEXT_PUBLIC_OPENCLAW_URL env var must match ngrok URL |
| Technician app | https://junkait.github.io/KoolAir- (GitHub Pages) |
| KoolAircon Jobs Drive folder | 1hxwi9RQGg9myRe-u9Rg6UdViHQ2wZDJJ |

3.3 Key Architecture Facts

Zero LLM calls on any operator command, webhook, or background timer path.

Only 3 external API endpoints: Telegram Bot API, Google Maps Distance Matrix, Meta Graph API.

Channel routing: determined by contact.Source.includes("WhatsApp") — not by incoming channel parameter alone.

pendingApprovals map: in-memory, keyed by inbox ID. Does NOT survive gateway restart — operator must re-run /b and /confirm.

syncInFlight: module-level boolean in index.ts. Prevents concurrent runSync executions. Must be module-level, not inside runSync.

sweepRanToday: module-level string. Set BEFORE first await after hour gate to prevent concurrent sweeps.

getSettings() TTL: 60 seconds. Safe to change 9_Settings without restart.

_zoneDayCache TTL: 60 minutes. Team_Schedule changes propagate within 60 minutes.

fillTemplate(): supports both {{param}} (Meta format) and [Param] (legacy) — backward compatible.

Booking page slot enumeration: 30-minute increments within AM/PM blocks. Deduplicated and sorted by startMins.

3.4 runSync Timer Blocks

Fires every 15 minutes. Four independent try/catch blocks inside one try/finally that releases syncInFlight:

| Block | Function | What it does |
| :-: | :-: | :-: |
| 1 | syncCalendarToJobs() | Creates Job rows from confirmed calendar events that have no job yet |
| 2 | detectAndMarkCompletedJobs() | Stamps Completed_At, updates Last_Job_Date, queues POST-D0-A draft |
| 3 | pollTechnicianSubmissions() | Scans Drive for _SUBMIT_ JSON files, routes fields to sheets via 1_App_Config |
| 4 | runDailyReminderSweep() | Daily at Sweep_Hour_SGT — generates reminder drafts, sends Q-NNN list, purges old inbox |

3.5 WhatsApp Integration

Webhook: https://flatly-aviator-turf.ngrok-free.dev/webhook/whatsapp (auth: plugin, match: exact)

Subscribed field: messages

Inbound flow:

POST → isOperatorNumber check → customer branch → handleInboundMessage() → contact created → inbox created → operator notified

POST → isOperatorNumber → Q-NNN check → handleQueueApproval → else INBOX-NNN → handleOperatorApproval

New functions in whatsapp.js (v3):

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
| End-to-end test | Not done | Templates not yet approved — doing partial test first |
| Meta template registration | Deferred | Live URLs needed: kool.com.sg/book, /refer, /review |
| Production Meta credentials | Deferred | Switch WA_Phone_Number_ID and WA_WABA_ID to production values in 9_Settings |
| Google Maps review link | Deferred | Google Maps listing not yet created |
| POST-D0-UTIL video header | Deferred | Need real dirty water video + Meta template approval |
| Photo bundle (YES flow) | Built, untested | Requires approved Meta number for media upload API |
| Cloudflare Tunnel (stable URL) | Deferred | Requires kool.com.sg domain purchase |
| Service report page | Deferred | Website access needed (kool.com.sg) |
| Tech app rebuild (dynamic form) | Deferred | After shadowing technicians + stable OpenClaw URL |
| ΔT measurement fields | Future phase | Equipment + training needed first |
| Sleep Better audit fields | Future phase | Equipment + training needed first |
| Web UI (operator dashboard) | Deferred | After end-to-end test and website |
| Referral credit mechanism | Deferred | Business decision on credit amount needed |
| Discount code system | Deferred | REM-3/4/5 reference discounts but no mechanism built |
| Booking page — kool.com.sg | Deferred | Currently on kool-pi.vercel.app. Move when domain accessible |

3.8 Known Bugs Fixed (v2 → v3)

In addition to all bugs fixed in v2, the following were fixed in this session:

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

Immediate priority: Buy kool.com.sg domain → set up Cloudflare Tunnel → get stable OpenClaw URL → submit templates to Meta → run end-to-end test.

Next session checklist:

1. Buy kool.com.sg (or koolaircon.com)

2. Point DNS to Cloudflare

3. Set up Cloudflare Tunnel → api.kool.com.sg → OVH server port 18789

4. Update NEXT_PUBLIC_OPENCLAW_URL in Vercel to new stable URL

5. Update webhook URL in Meta console

6. Set up redirects: kool.com.sg/book, /refer, /review, /report

7. Update URL_* settings in 9_Settings

8. Submit all 10 templates to Meta via registerWhatsAppTemplate()

9. Run full end-to-end test

10. Shadow technicians → update 1_App_Config and rebuild tech app
