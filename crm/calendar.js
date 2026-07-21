/**
 * calendar.js — Google Calendar integration for KoolAircon CRM
 *
 * The calendar IS the source of truth for bookings:
 *   - Bot creates tentative events on /b, confirms them on /confirmb.
 *   - Jun Kai can also create events manually in Google Calendar —
 *     the 15-min sync job picks those up and writes Job rows.
 *
 * Event encoding:
 *   Title:       <Contact_ID> <Full_Name> — <Service> ×<Units>  [tentative=INBOX-XXX]
 *   Description: structured key:value block bracketed by `---` so it survives
 *                manual edits and can be re-parsed by the sync job.
 *
 * If Jun Kai manually creates an event with no structured block, we try to
 * extract the contact id from the title (e.g. "KA-0007 ...").
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = join(__dirname, '..', '.openclaw', 'secrets', 'gsheets-credentials.json');

export const CALENDAR_ID = process.env.KOOLAIRCON_CALENDAR_ID
  || '5d0a5d4947473f83f855ce090ac206db955492a254ef352a4df2704fc3482e01@group.calendar.google.com';
export const CALENDAR_TZ = 'Asia/Singapore';

let _cal = null;
async function getCal() {
  if (_cal) return _cal;
  const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  _cal = google.calendar({ version: 'v3', auth: await auth.getClient() });
  return _cal;
}

// ─── Encoding / Decoding ─────────────────────────────────────────────────────

/**
 * Build a structured description block embedded in the event description.
 * Manual edits above/below the block are preserved on round-trip.
 */
export function buildDescription(meta, freeText = '') {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  if (freeText) {
    return `${freeText}\n\n${lines.join('\n')}`;
  }
  return lines.join('\n');
}

const META_BLOCK_RE = /---\s*\n([\s\S]*?)\n---/;

export function parseDescription(description) {
  if (!description) return {};
  const m = description.match(META_BLOCK_RE);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// Title looks like:
//   "KA-0003 Duri.G — GC ×3 [INBOX-003]"
// or after confirmation:
//   "KA-0003 Duri.G — GC ×3 (JOB-20260616-001)"
const CONTACT_ID_RE = /\b(KA-\d{4}|TEST-[A-Za-z0-9._-]+)\b/;
const INBOX_TAG_RE = /\bINBOX-\d{3,}\b/;
const JOB_TAG_RE = /\bJOB-\d{8}-\d{3,}\b/;

export function extractFromTitle(title) {
  const t = String(title || '');
  return {
    contactId: (t.match(CONTACT_ID_RE) || [])[1] || null,
    inboxId: (t.match(INBOX_TAG_RE) || [])[0] || null,
    jobId: (t.match(JOB_TAG_RE) || [])[0] || null,
  };
}

export function buildTitle({ contactId, fullName, serviceLabel, units, tag }) {
  const who = [contactId, fullName].filter(Boolean).join(' ');
  const svc = [serviceLabel, units ? `×${units}` : null].filter(Boolean).join(' ');
  const tail = tag ? ` ${tag}` : '';
  return `${who} — ${svc}${tail}`.trim();
}

// ─── Free/busy ───────────────────────────────────────────────────────────────

/**
 * Return busy intervals on the booking calendar between timeMin and timeMax.
 * Each interval: { start: Date, end: Date }.
 */
export async function getBusyIntervals(calendarIdOrTimeMin, timeMinOrTimeMax, timeMaxArg) {
  // Support both old 2-arg signature (timeMin, timeMax)
  // and new 3-arg signature (calendarId, timeMin, timeMax)
  let calId, timeMin, timeMax;
  if (timeMaxArg !== undefined) {
    // 3-arg: (calendarId, timeMin, timeMax)
    calId = calendarIdOrTimeMin;
    timeMin = timeMinOrTimeMax;
    timeMax = timeMaxArg;
  } else {
    // 2-arg legacy: (timeMin, timeMax)
    calId = CALENDAR_ID;
    timeMin = calendarIdOrTimeMin;
    timeMax = timeMinOrTimeMax;
  }
  // Normalise to Date objects
  if (typeof timeMin === 'string') timeMin = new Date(timeMin);
  if (typeof timeMax === 'string') timeMax = new Date(timeMax);
  const cal = await getCal();
  const resp = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: CALENDAR_TZ,
      items: [{ id: calId }],
    },
  });
  const busy = resp.data.calendars?.[calId]?.busy || [];
  return busy.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
}

/**
 * List events between timeMin and timeMax (inclusive of tentative).
 */
export async function listEvents(timeMin, timeMax, opts = {}, calendarId = CALENDAR_ID) {
  const cal = await getCal();
  const resp = await cal.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    showDeleted: false,
    maxResults: opts.maxResults || 250,
  });
  return resp.data.items || [];
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Create a calendar event for a (potential) booking.
 *   args: { title, start (Date), end (Date), description, status }
 * status: 'tentative' (default) | 'confirmed'
 */
export async function createEvent({ title, start, end, description, status = 'tentative', colorId, calendarId: calId }) {
  const cal = await getCal();
  const resp = await cal.events.insert({
    calendarId: calId || CALENDAR_ID,
    requestBody: {
      summary: title,
      description: description || '',
      start: { dateTime: start.toISOString(), timeZone: CALENDAR_TZ },
      end:   { dateTime: end.toISOString(),   timeZone: CALENDAR_TZ },
      status,
      ...(colorId ? { colorId } : {}),
    },
  });
  return resp.data;
}

// Not yet used — reserved for future /cancel command
export async function getEvent(eventId, calendarId = CALENDAR_ID) {
  const cal = await getCal();
  try {
    const resp = await cal.events.get({ calendarId, eventId });
    return resp.data;
  } catch (e) {
    if (e.code === 404) return null;
    throw e;
  }
}

export async function updateEvent(eventId, patch, calendarId = CALENDAR_ID) {
  const cal = await getCal();
  const resp = await cal.events.patch({
    calendarId,
    eventId,
    requestBody: patch,
  });
  return resp.data;
}

// Not yet used — reserved for future /cancel command
export async function deleteEvent(eventId, calendarId = CALENDAR_ID) {
  const cal = await getCal();
  await cal.events.delete({ calendarId, eventId });
}

/**
 * Find events with a matching inbox_id (either in title tag like [INBOX-003] or
 * in the description block `inbox_id: INBOX-003`).
 */
export async function findEventsByInbox(inboxId, opts = {}, calendarId = CALENDAR_ID) {
  const lookAheadDays = opts.lookAheadDays || 60;
  const lookBackDays = opts.lookBackDays || 1;
  const now = new Date();
  const timeMin = new Date(now.getTime() - lookBackDays * 24 * 60 * 60 * 1000);
  const timeMax = new Date(now.getTime() + lookAheadDays * 24 * 60 * 60 * 1000);
  const events = await listEvents(timeMin, timeMax, {}, calendarId);
  return events.filter(ev => {
    const meta = parseDescription(ev.description);
    if (meta.inbox_id === inboxId) return true;
    const tit = extractFromTitle(ev.summary);
    return tit.inboxId === inboxId;
  });
}

// ─── Zone color mapping (visual aid in calendar) ─────────────────────────────
// Google Calendar event colorIds: 1=lavender, 2=sage, 3=grape, 4=flamingo,
// 5=banana, 6=tangerine, 7=peacock, 8=graphite, 9=blueberry, 10=basil, 11=tomato
export const ZONE_COLOR = {
  Z1: '6',  // tangerine — Far East
  Z2: '5',  // banana    — Inner East
  Z3: '9',  // blueberry — Central
  Z4: '7',  // peacock   — North
  Z5: '10', // basil     — North-East
  Z6: '2',  // sage      — West
  Z7: '3',  // grape     — South / CBD
  Z8: '4',  // flamingo  — North-West
};
