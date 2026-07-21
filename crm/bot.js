/**
 * bot.js — Core config, shared state, and barrel re-exports for KoolAircon CRM
 *
 * This is the central hub. Domain modules import sendTelegram,
 * OPERATOR_TELEGRAM_ID, and pendingApprovals from here.
 *
 * Business logic lives in:
 * crm.js — inbound messages, operator approval, queue
 * booking.js — slot finding, confirmation, calendar booking
 * module3.js — automation sweep, job completion detection
 *
 * index.ts imports all handlers from bot.js — the re-exports below
 * keep those imports unchanged.
 */

// ── Startup credential validation ─────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
 throw new Error('[bot] FATAL: BOT_TOKEN env var is not set. Add it to the supervisord environment= line and restart.');
}

// ── Config ─────────────────────────────────────────────────────────────────────
export const OPERATOR_TELEGRAM_ID = '126686924';
export { BOT_TOKEN };
export const BLOCK_SIZE_MINS = 30;

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Shared in-memory state ─────────────────────────────────────────────────────
//
// pendingApprovals: keyed by inboxId (e.g. "INBOX-008").
// Holds staged booking state for active operator flows.
// Does NOT survive a gateway restart — operator must re-run /b and /confirm.
// Deliberate v1 decision: low volume makes mid-flow restarts rare.
export const pendingApprovals = new Map();

export function getStagedSlots() {
 const staged = new Set();
 for (const pending of pendingApprovals.values()) {
 const fc = pending.finalizationContext;
 if (fc?.slot?.Date && fc?.slot?.Block) {
 staged.add(`${fc.slot.Date}|${fc.slot.Block}`);
 }
 }
 return staged;
}

// ── Telegram API ───────────────────────────────────────────────────────────────
export async function sendTelegram(chatId, text) {
 const res = await fetch(`${TG_API}/sendMessage`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
 });
 const data = await res.json();
 if (!data.ok) {
 console.error('[bot] Telegram error:', data);
 throw new Error(`Telegram API error: ${data.description}`);
 }
 return data;
}

// ── syncCalendarToJobs ─────────────────────────────────────────────────────────
// Kept here rather than moved to a domain file — called directly by the
// index.ts runSync timer. Moving it would require updating index.ts imports.

import {
 getContacts,
 getJobs,
 createJob,
 getPriceFromTable,
} from './sheets.js';

import {
 parseDescription as calParseDescription,
 extractFromTitle as calExtractFromTitle,
 buildDescription as calBuildDescription,
 updateEvent as calUpdateEvent,
 listEvents,
} from './calendar.js';

function sgtPartsFromDate(date) {
 const fmt = new Intl.DateTimeFormat('en-CA', {
 timeZone: 'Asia/Singapore',
 year: 'numeric', month: '2-digit', day: '2-digit',
 hour: '2-digit', minute: '2-digit', hour12: false,
 });
 const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
 const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
 const hh = parseInt(parts.hour, 10);
 const mm = parseInt(parts.minute, 10);
 return { date: dateStr, hhmm: `${parts.hour}:${parts.minute}`, mins: hh * 60 + mm };
}

export async function syncCalendarToJobs({ lookBackDays = 1, lookAheadDays = 30 } = {}) {
 const now = new Date();
 const timeMin = new Date(now.getTime() - lookBackDays * 24 * 60 * 60 * 1000);
 const timeMax = new Date(now.getTime() + lookAheadDays * 24 * 60 * 60 * 1000);

 const events = await listEvents(timeMin, timeMax);
 const jobs = await getJobs();
 const jobsByCalEvent = new Map();
 const jobsById = new Map();
 for (const j of jobs) {
 if (j.Calendar_Event_ID) jobsByCalEvent.set(j.Calendar_Event_ID, j);
 if (j.Job_ID) jobsById.set(j.Job_ID, j);
 }

 const created = [];
 const skipped = [];
 const failed = [];

 for (const ev of events) {
 if (ev.status && ev.status !== 'confirmed') {
 skipped.push({ id: ev.id, reason: 'not_confirmed' });
 continue;
 }
 if (!ev.start?.dateTime || !ev.end?.dateTime) {
 skipped.push({ id: ev.id, reason: 'no_datetime' });
 continue;
 }
 if (jobsByCalEvent.has(ev.id)) {
 skipped.push({ id: ev.id, reason: 'already_synced' });
 continue;
 }
 const meta = calParseDescription(ev.description);
 const titleParts = calExtractFromTitle(ev.summary);
 const contactId = meta.contact_id || titleParts.contactId;
 if (!contactId) {
 skipped.push({ id: ev.id, reason: 'no_contact_id', title: ev.summary });
 continue;
 }
 if (meta.job_id && jobsById.has(meta.job_id)) {
 skipped.push({ id: ev.id, reason: 'job_already_exists', jobId: meta.job_id });
 continue;
 }

 try {
 const contacts = await getContacts();
 const contact = contacts.find(c => c.Contact_ID === contactId);
 if (!contact) {
 failed.push({ id: ev.id, reason: `contact ${contactId} not found` });
 continue;
 }

 const start = new Date(ev.start.dateTime);
 const end = new Date(ev.end.dateTime);
 const startParts = sgtPartsFromDate(start);
 const endParts = sgtPartsFromDate(end);
 const serviceType = (meta.service || (ev.summary?.match(/\b(GC|CW|CO|AS)\b/) || [])[0] || 'GC').toUpperCase();
 const units = parseInt(meta.units || (ev.summary?.match(/×(\d+)/) || [])[1] || '1', 10);
 const price = parseInt(meta.price_sgd, 10) > 0
 ? parseInt(meta.price_sgd, 10)
 : await getPriceFromTable(serviceType, units);

 const jobResult = await createJob({
 Contact_ID: contact.Contact_ID,
 Customer_Name: contact.Full_Name,
 Job_Date: startParts.date,
 Service_Type: serviceType,
 Units: units,
 Price_SGD: price,
 Address: meta.address || contact.Address || '',
 Notes: `Synced from calendar event ${ev.id}. Time: ${startParts.hhmm}–${endParts.hhmm}. ${meta.inbox_id ? `Inbox: ${meta.inbox_id}` : '(manual entry)'}`,
 Calendar_Event_ID: ev.id,
 Team_ID: '',
 });
 const jobId = jobResult?.Job_ID;
 created.push({ eventId: ev.id, jobId, contactId, date: startParts.date });

 try {
 const newMeta = { ...meta, contact_id: contactId, job_id: jobId };
 const lines = ['---'];
 for (const [k, v] of Object.entries(newMeta)) {
 if (v === undefined || v === null || v === '') continue;
 lines.push(`${k}: ${v}`);
 }
 lines.push('---');
 const freeText = (ev.description || '').replace(/---\s*\n[\s\S]*?\n---/, '').trim();
 const newDescription = freeText ? `${freeText}\n\n${lines.join('\n')}` : lines.join('\n');
 await calUpdateEvent(ev.id, { description: newDescription });
 } catch (e) {
 console.error('[bot] sync: failed to back-link job_id to event', ev.id, e.message);
 }

 if (!meta.inbox_id) {
 try {
 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `🔄 <b>Manual calendar event synced</b>\n` +
 `Event: "${ev.summary || '(no title)'}"\n` +
 `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n` +
 `When: ${startParts.date} ${startParts.hhmm}–${endParts.hhmm}\n` +
 `Service: ${serviceType} ×${units}\n` +
 `✅ Job created: <b>${jobId}</b>`
 );
 } catch (e) { /* notify is best-effort */ }
 }
 } catch (e) {
 failed.push({ id: ev.id, reason: e.message });
 console.error('[bot] sync failed for event', ev.id, e);
 }
 }

 console.log(`[bot] Calendar sync: created=${created.length}, skipped=${skipped.length}, failed=${failed.length}`);
 return { created, skipped, failed };
}

// ── Re-exports from domain modules ─────────────────────────────────────────────
// index.ts imports all handlers from bot.js — these keep those imports unchanged.

export {
 handleInboundMessage,
 handleInfoCommand,
 handleOperatorApproval,
 handleQueueApproval,
 isQueueApprovalText,
} from './crm.js';

export {
 handleBookingCommand,
 handleConfirmSlot,
 handleConfirmBooking,
 handleMixYes,
 handleMixNo,
 handleCheckCal,
 handleCalInfo,
} from './booking.js';

export {
 runDailyReminderSweep,
 detectAndMarkCompletedJobs,
} from './module3.js';

// handleBookingInfo — utility used by index.js directly
export async function handleBookingInfo(contactId, postalCode, serviceType, units) {
 const { getZoneFromPostal, getDurationMins, findAvailableSlots, formatSlotOptions } = await import('./scheduler.js');
 const { getContacts } = await import('./sheets.js');
 const zone = await getZoneFromPostal(postalCode);
 if (!zone) return { success: false, message: `Could not find zone for postal code ${postalCode}.` };
 const durationMins = await getDurationMins(serviceType, units);
 const contacts = await getContacts();
 const bookingContact = contacts.find(c => c.Contact_ID === contactId);
 const slots = await findAvailableSlots(zone.Zone_ID, durationMins, 3, bookingContact?.Assigned_Team || '');
 const formatted = formatSlotOptions(slots);
 return { success: true, zone, durationMins, slots, formattedOptions: formatted };
}
