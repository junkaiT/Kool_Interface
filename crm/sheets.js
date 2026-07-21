/**
 * sheets.js - Google Sheets helper module for KoolAircon CRM
 *
 * Sheet structure (all sheets):
 * Row 1: title metadata
 * Row 2: description metadata
 * Row 3: headers (EXCEPT 7_Postal_Zones which has a section heading on row 3)
 * Row 4: column descriptions (skip — not data)
 * Row 5+: actual data
 *
 * 7_Postal_Zones: row3=section heading, row4=headers, row5+=data
 * 8_Service_Durations: service duration table starts at row 14 (headers) / row 15 (data)
 *
 * DYNAMIC DESIGN: createContact and all write operations look up column positions
 * from the actual sheet headers at runtime. Adding, removing, or reordering columns
 * in Google Sheets will never break these functions.
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SPREADSHEET_ID = '1YSU2zdeijOyp4KZYxav6ASoLLNst6IrPZ5Vo2lB05p4';
const TECH_APP_SPREADSHEET_ID = '1Oa8szd_6Zy9lAkZHpwq_aH6zKGSUcAjlXjZsKOkW258';
const CREDS_PATH = join(__dirname, '..', '.openclaw', 'secrets', 'gsheets-credentials.json');

const SHEETS = {
 CONTACTS: '1_Contacts',
 JOBS: '2_Jobs',
 TEMPLATES: '4_Templates',
 MESSAGE_LOG: '5_Message_Log',
 OPERATOR_INBOX: '6_Operator_Inbox',
 POSTAL_ZONES: '7_Postal_Zones',
 SERVICE_DURATIONS: '8_Service_Durations',
 PRICING: '10_Pricing Table',
  TEAM_SCHEDULE: 'Team_Schedule',
  SETTINGS: '9_Settings',
  QUEUE: 'Module3_Queue',
};

const SHEET_CONFIG = {
 [SHEETS.CONTACTS]: { headerIdx: 2, skipAfterHeader: 1, appendColLimit: 'AC' },
 [SHEETS.JOBS]: { headerIdx: 2, skipAfterHeader: 1 },
 [SHEETS.TEMPLATES]: { headerIdx: 2, skipAfterHeader: 1 },
 [SHEETS.MESSAGE_LOG]: { headerIdx: 2, skipAfterHeader: 1 },
 [SHEETS.OPERATOR_INBOX]: { headerIdx: 2, skipAfterHeader: 1 },
 [SHEETS.POSTAL_ZONES]: { headerIdx: 3, skipAfterHeader: 0 },
 [SHEETS.SERVICE_DURATIONS]: { range: `8_Service_Durations!A14:F19`, headerIdx: 0, skipAfterHeader: 0 },
 [SHEETS.PRICING]: { headerIdx: 1, skipAfterHeader: 0 },
  [SHEETS.TEAM_SCHEDULE]: { headerIdx: 1, skipAfterHeader: 0 },
  [SHEETS.SETTINGS]: { headerIdx: 1, skipAfterHeader: 0 },
  [SHEETS.QUEUE]:    { headerIdx: 0, skipAfterHeader: 0 },
};

let _sheets = null;

// ─── Read caches ─────────────────────────────────────────────────────────────
let _contactCache = null;
let _contactCacheAt = 0;
let _jobCache = null;
let _jobCacheAt = 0;
let _templateCache = null;
let _templateCacheAt = 0;
let _postalZoneCache = null;
let _postalZoneCacheAt = 0;
let _serviceDurCache = null;
let _serviceDurCacheAt = 0;

// ─── Write queue ─────────────────────────────────────────────────────────────
const _writeQueue = [];
let _writeBatchTimer = null;

async function queueWrite(fn) {
  return new Promise((resolve, reject) => {
    _writeQueue.push({ fn, resolve, reject });
    scheduleWriteBatch();
  });
}

function scheduleWriteBatch() {
  if (_writeBatchTimer) return;
  let delayMs = 500;
  if (_settingsCache) {
    delayMs = parseInt(_settingsCache.Write_Batch_Delay_Ms ?? '500', 10) || 500;
  }
  _writeBatchTimer = setTimeout(flushWriteQueue, delayMs);
}

async function flushWriteQueue() {
  _writeBatchTimer = null;
  if (_writeQueue.length === 0) return;
  const batch = _writeQueue.splice(0, _writeQueue.length);
  const settings = await getSettings();
  const maxRetry = parseInt(settings.Write_Retry_Max ?? '3', 10);
  for (const item of batch) {
    let attempts = 0;
    let delay = 2000;
    while (attempts <= maxRetry) {
      try {
        const result = await item.fn();
        item.resolve(result);
        break;
      } catch (e) {
        if (e?.response?.status === 429 && attempts < maxRetry) {
          attempts++;
          console.warn(`[sheets] 429 rate limit, retrying in ${delay}ms (attempt ${attempts}/${maxRetry})`);
          await new Promise(r => setTimeout(r, delay));
          delay *= 2;
        } else {
          item.reject(e);
          break;
        }
      }
    }
  }
}

async function getSheets() {
 if (_sheets) return _sheets;
 const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
 const auth = new google.auth.GoogleAuth({
 credentials: creds,
 scopes: ['https://www.googleapis.com/auth/spreadsheets'],
 });
 _sheets = google.sheets({ version: 'v4', auth });
 return _sheets;
}

export async function purgeOperatorInbox(daysOld = 7) {
 const sleep = ms => new Promise(r => setTimeout(r, ms));
 const rows = await getOperatorInbox();
 const cutoff = new Date();
 cutoff.setDate(cutoff.getDate() - daysOld);
 const cutoffStr = cutoff.toISOString().slice(0, 10);

 // Find rows older than cutoff — check Created_At or Timestamp column
 const toDelete = rows.filter(r => {
 const ts = (r.Created_At || r.Timestamp || r.Date || '').slice(0, 10);
 return ts && ts < cutoffStr;
 });

 if (toDelete.length === 0) {
 console.log('[sheets] purgeOperatorInbox: nothing to purge');
 return { purged: 0 };
 }

 console.log(`[sheets] purgeOperatorInbox: purging ${toDelete.length} entries older than ${cutoffStr}`);
 let purged = 0;
 for (const row of toDelete) {
 try {
 const found = await findInboxById(row.Inbox_ID);
 if (found) {
 const sheetId = await getSheetIdByTitle(SHEETS.OPERATOR_INBOX);
 const rowIndex = found.rowNum - 1;
 await (await getSheets()).spreadsheets.batchUpdate({
 spreadsheetId: SPREADSHEET_ID,
 requestBody: { requests: [{ deleteDimension: { range: {
 sheetId, dimension: 'ROWS',
 startIndex: rowIndex, endIndex: rowIndex + 1,
 }}}]},
 });
 purged++;
 await sleep(1000);
 }
 } catch (err) {
 console.error(`[sheets] purgeOperatorInbox: error deleting ${row.Inbox_ID}: ${err.message}`);
 }
 }
 console.log(`[sheets] purgeOperatorInbox: done — purged ${purged} entries`);
 return { purged };
}

async function readSheet(sheetName) {
 const sheets = await getSheets();
 const cfg = SHEET_CONFIG[sheetName] || { headerIdx: 2, skipAfterHeader: 1 };
 const range = cfg.range || sheetName;
 const res = await sheets.spreadsheets.values.get({
 spreadsheetId: SPREADSHEET_ID,
 range,
 });
 const rows = res.data.values || [];
 if (rows.length <= cfg.headerIdx) return [];
 const headers = rows[cfg.headerIdx];
 const dataStart = cfg.headerIdx + 1 + (cfg.skipAfterHeader || 0);
 return rows.slice(dataStart).map(row => {
 const obj = {};
 headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
 return obj;
 });
}

async function getSheetHeaders(sheetName) {
 const sheets = await getSheets();
 const cfg = SHEET_CONFIG[sheetName] || { headerIdx: 2, skipAfterHeader: 1 };
 const headerRowNum = cfg.headerIdx + 1;
 const res = await sheets.spreadsheets.values.get({
 spreadsheetId: SPREADSHEET_ID,
 range: `${sheetName}!${headerRowNum}:${headerRowNum}`,
 });
 const raw = (res.data.values || [[]])[0] || [];
 const lastNonEmpty = raw.reduce((last, h, i) => (h && h.trim() ? i : last), -1);
 return lastNonEmpty >= 0 ? raw.slice(0, lastNonEmpty + 1) : raw;
}

function dataStartRowNum(sheetName) {
 const cfg = SHEET_CONFIG[sheetName] || { headerIdx: 2, skipAfterHeader: 1 };
 return cfg.headerIdx + 1 + (cfg.skipAfterHeader || 0) + 1;
}

async function appendRow(sheetName, values) {
 const sheets = await getSheets();
 const cfg = SHEET_CONFIG[sheetName] || { headerIdx: 2, skipAfterHeader: 1 };
 const dataStartRow = cfg.headerIdx + 1 + (cfg.skipAfterHeader || 0) + 1;
 await queueWrite(async () => {
  const res = await sheets.spreadsheets.values.get({
   spreadsheetId: SPREADSHEET_ID,
   range: `${sheetName}!A${dataStartRow}:A`,
   valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const colAValues = res.data.values || [];
  const firstEmptyRow = dataStartRow + colAValues.length;
  return sheets.spreadsheets.values.update({
   spreadsheetId: SPREADSHEET_ID,
   range: `${sheetName}!A${firstEmptyRow}`,
   valueInputOption: 'USER_ENTERED',
   requestBody: { values: [values] },
  });
 });
}

async function updateRow(sheetName, sheetRowNum, colValues) {
 const sheets = await getSheets();
 const requests = colValues.map(({ col, value }) => ({
 range: `${sheetName}!${col}${sheetRowNum}`,
 values: [[value]],
 }));
 await queueWrite(() => sheets.spreadsheets.values.batchUpdate({
 spreadsheetId: SPREADSHEET_ID,
 requestBody: { valueInputOption: 'USER_ENTERED', data: requests },
 }));
}

function buildRowFromHeaders(headers, data) {
 return headers.map(h => {
 const val = data[h];
 if (val === undefined || val === null) return '';
 return String(val);
 });
}

export async function getContacts() {
 const settings = await getSettings();
 const ttlMins = parseFloat(settings.Contact_Cache_TTL_Mins ?? '5');
 if (ttlMins === 0) return readSheet(SHEETS.CONTACTS);
 const ttlMs = ttlMins * 60 * 1000;
 if (_contactCache && Date.now() - _contactCacheAt < ttlMs) return _contactCache;
 _contactCache = await readSheet(SHEETS.CONTACTS);
 _contactCacheAt = Date.now();
 return _contactCache;
}

export async function findContactByChannelId(channelId) {
 const contacts = await getContacts();
 return contacts.find(c => c.Channel_Contact_ID === String(channelId)) || null;
}

async function nextContactId() {
 const contacts = await getContacts();
 const ids = contacts
 .map(c => parseInt((c.Contact_ID || '').replace('KA-', ''), 10))
 .filter(n => !isNaN(n));
 const max = ids.length > 0 ? Math.max(...ids) : 0;
 return `KA-${String(max + 1).padStart(4, '0')}`;
}

export async function createContact(data) {
 const id = await nextContactId();
 const now = getSGTDate();
 const headers = await getSheetHeaders(SHEETS.CONTACTS);

 const contactData = {
 Contact_ID: id,
 Full_Name: data.Full_Name || 'Unknown',
 Primary_Channel: data.Primary_Channel || 'Telegram',
 Channel_Contact_ID: String(data.Channel_Contact_ID || ''),
 Secondary_Channel: data.Secondary_Channel || '',
 Email: data.Email || '',
 Type: data.Type || 'Residential',
 Address_Area: data.Address_Area || '',
 Address: data.Address || '',
 Postal_Code: data.Postal_Code || '',
 Phone: data.Phone || '',
 Source: data.Source || 'Telegram',
 Referrer_Name: data.Referrer_Name || '',
 Consent: data.Consent || 'Unknown',
 Opt_Out: data.Opt_Out || 'FALSE',
 Opt_Out_Date: data.Opt_Out_Date || '',
 Contact_Status: data.Contact_Status || 'Lead',
 Last_Job_Date: '',
 Days_Since_Last_Job: '',
 Total_Jobs: '0',
 Total_Spend_SGD: '0',
 VIP_Tag: 'FALSE',
 Children_In_Home: 'FALSE',
 Elderly_In_Home: 'FALSE',
 Pets_In_Home: 'FALSE',
 Google_Review_Given: 'FALSE',
 Google_Review_Date: '',
 Notes: data.Notes || '',
 Created_Date: now,
 Last_Updated: now,
 };

 const row = buildRowFromHeaders(headers, contactData);
 await appendRow(SHEETS.CONTACTS, row);
 _contactCache = null;
 _contactCacheAt = 0;

 return {
 Contact_ID: id,
 Full_Name: contactData.Full_Name,
 Channel_Contact_ID: contactData.Channel_Contact_ID,
 Contact_Status: contactData.Contact_Status,
 Address_Area: contactData.Address_Area,
 Postal_Code: contactData.Postal_Code,
 Created_Date: now,
 Last_Updated: now,
 };
}

export async function updateContact(contactId, fields) {
 const contacts = await getContacts();
 const headers = await getSheetHeaders(SHEETS.CONTACTS);
 const cfg = SHEET_CONFIG[SHEETS.CONTACTS];
 const dataStart = cfg.headerIdx + 1 + (cfg.skipAfterHeader || 0) + 1;
 const rowIdx = contacts.findIndex(c => c.Contact_ID === contactId);
 if (rowIdx === -1) throw new Error(`Contact not found: ${contactId}`);
 const sheetRow = dataStart + rowIdx;
 const colValues = Object.entries(fields).map(([col, value]) => ({
 col: colLetterFromHeader(headers, col),
 value,
 }));
 _contactCache = null;
 _contactCacheAt = 0;
 await updateRow(SHEETS.CONTACTS, sheetRow, colValues);
}

export async function updateJob(jobId, fields) {
 const jobs = await getJobs();
 const headers = await getSheetHeaders(SHEETS.JOBS);
 const cfg = SHEET_CONFIG[SHEETS.JOBS];
 const dataStart = cfg.headerIdx + 1 + (cfg.skipAfterHeader || 0) + 1;
 const rowIdx = jobs.findIndex(j => j.Job_ID === jobId);
 if (rowIdx === -1) throw new Error(`Job not found: ${jobId}`);
 const sheetRow = dataStart + rowIdx;
 const colValues = Object.entries(fields).map(([col, value]) => ({
 col: colLetterFromHeader(headers, col),
 value,
 }));
 _jobCache = null;
 _jobCacheAt = 0;
 await updateRow(SHEETS.JOBS, sheetRow, colValues);
}

export async function getTemplates() {
 const TTL_MS = 15 * 60 * 1000; // 15 minutes — templates change very rarely
 if (_templateCache && Date.now() - _templateCacheAt < TTL_MS) return _templateCache;
 _templateCache = await readSheet(SHEETS.TEMPLATES);
 _templateCacheAt = Date.now();
 return _templateCache;
}

export async function getTemplate(templateId) {
 const templates = await getTemplates();
 return templates.find(t => t.Template_ID === templateId) || null;
}

export function fillTemplate(text, vars = {}) {
  if (!text) return '';
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    // Support both {{key}} (Meta format) and [Key] (legacy) for backward compatibility
    result = result.replaceAll(`{{${key}}}`, value ?? '');
    result = result.replaceAll(`[${key}]`, value ?? '');
  }
  return result;
}

export async function logMessage(data) {
 const now = getSGTDateTime();
 const headers = await getSheetHeaders(SHEETS.MESSAGE_LOG);
 const rowData = {
 Log_ID: '',
 Contact_ID: data.Contact_ID || '',
 Customer_Name: data.Customer_Name || '',
 Template_ID: data.Template_ID || '',
 Channel: data.Channel || 'Telegram',
 Sent_At: now,
 Delivery_Status: data.Direction === 'Inbound' ? 'Received' : (data.Status || 'Sent'),
 Customer_Replied: data.Direction === 'Inbound' ? 'TRUE' : 'FALSE',
 Reply_Content: data.Direction === 'Inbound' ? (data.Message_Text || '') : '',
 Reply_Sentiment: '',
 Converted: 'FALSE',
 Resulting_Job_ID: '',
 A_B_Variant: 'A',
 Message_Text: data.Message_Text || '',
 Sent_By: data.Sent_By || '',
 Direction: data.Direction || '',
 };
 const row = buildRowFromHeaders(headers, rowData);
 await appendRow(SHEETS.MESSAGE_LOG, row);
}

export async function getOperatorInbox() {
 return readSheet(SHEETS.OPERATOR_INBOX);
}

async function nextInboxId() {
 const rows = await getOperatorInbox();
 const ids = rows
 .map(r => parseInt((r.Inbox_ID || '').replace(/^INBOX-/i, ''), 10))
 .filter(n => !isNaN(n));
 const max = ids.length > 0 ? Math.max(...ids) : 0;
 return `INBOX-${String(max + 1).padStart(3, '0')}`;
}

function parseSGTDate(s) {
 if (!s) return null;
 let m = s.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
 if (m) {
 const [, y, mo, d, h, mi, se] = m;
 return new Date(Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +(se || 0)));
 }
 m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
 if (m) {
 let [, d, mo, y, h, mi, se, ampm] = m;
 let hr = +h;
 if (ampm) {
 if (/PM/i.test(ampm) && hr < 12) hr += 12;
 if (/AM/i.test(ampm) && hr === 12) hr = 0;
 }
 return new Date(Date.UTC(+y, +mo - 1, +d, hr - 8, +mi, +(se || 0)));
 }
 return null;
}

export async function findInboxById(inboxId) {
 const rows = await getOperatorInbox();
 const dataStart = dataStartRowNum(SHEETS.OPERATOR_INBOX);
 const target = inboxId.toUpperCase();
 for (let i = 0; i < rows.length; i++) {
 if ((rows[i].Inbox_ID || '').toUpperCase() === target) {
 return { inboxId: rows[i].Inbox_ID, rowNum: dataStart + i, row: rows[i] };
 }
 }
 return null;
}

export async function findJobById(jobId) {
 const rows = await getJobs();
 const dataStart = dataStartRowNum(SHEETS.JOBS);
 const target = jobId.toUpperCase();
 for (let i = 0; i < rows.length; i++) {
 if ((rows[i].Job_ID || '').toUpperCase() === target) {
 return { id: rows[i].Job_ID, rowNum: dataStart + i, row: rows[i] };
 }
 }
 return null;
}

export async function findOpenInboxForContact(contactId, hoursWindow = null) {
 const rows = await getOperatorInbox();
 const dataStart = dataStartRowNum(SHEETS.OPERATOR_INBOX);
 const window = hoursWindow ?? parseInt((await getSettings()).Inbox_Dedup_Window_Hours ?? '24', 10);
 const cutoff = Date.now() - window * 60 * 60 * 1000;
 for (let i = rows.length - 1; i >= 0; i--) {
 const r = rows[i];
 if (r.Contact_ID !== contactId) continue;
 if (!r.Inbox_ID || !/^INBOX-\d+$/i.test(r.Inbox_ID)) continue;
 const received = parseSGTDate(r.Received_At);
 if (received && received.getTime() < cutoff) continue;
 return { inboxId: r.Inbox_ID, rowNum: dataStart + i, row: r };
 }
 return null;
}

export async function addToInbox(data) {
 const now = getSGTDateTime();
 const inboxId = await nextInboxId();
 const slaHours = parseInt((await getSettings()).Operator_SLA_Hours ?? '2', 10);
 const sla = new Date(Date.now() + slaHours * 60 * 60 * 1000)
 .toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });
 const headers = await getSheetHeaders(SHEETS.OPERATOR_INBOX);
 const rowData = {
 Inbox_ID: inboxId,
 Received_At: now,
 Contact_ID: data.Contact_ID || '',
 Customer_Name: data.Contact_Name || '',
 Channel: data.Channel || 'Telegram',
 Message_Snippet: (data.Customer_Message || '').substring(0, 80),
 Full_Message: data.Customer_Message || '',
 Classification: data.Classification || 'Quote',
 Drafted_Reply: data.Draft_Reply || '',
 SLA_Due_By: sla,
 Status: data.Status || 'Pending',
 Resolved_At: '',
 Operator_Reply: '',
 Notes: data.Notes || '',
 };
 const row = buildRowFromHeaders(headers, rowData);
 await appendRow(SHEETS.OPERATOR_INBOX, row);
 return inboxId;
}

export async function appendToInbox(rowNum, newMessage, newDraft, existing = {}) {
 const ts = getSGTDateTime();
 const sep = '\n---\n';
 const updatedMessage = (existing.Full_Message || '') + sep + `[${ts}] ` + (newMessage || '');
 const updatedDraft = (existing.Drafted_Reply || '') + sep + `[${ts}] ` + (newDraft || '');
 const snippet = (newMessage || '').substring(0, 80);
 const headers = await getSheetHeaders(SHEETS.OPERATOR_INBOX);
 const colValues = [
 { col: colLetterFromHeader(headers, 'Message_Snippet'), value: snippet },
 { col: colLetterFromHeader(headers, 'Full_Message'), value: updatedMessage },
 { col: colLetterFromHeader(headers, 'Drafted_Reply'), value: updatedDraft },
 { col: colLetterFromHeader(headers, 'Status'), value: 'Pending' },
 ];
 await updateRow(SHEETS.OPERATOR_INBOX, rowNum, colValues);
}

export async function resolveInbox(rowNum, operatorReply) {
 const ts = getSGTDateTime();
 const headers = await getSheetHeaders(SHEETS.OPERATOR_INBOX);
 const colValues = [
 { col: colLetterFromHeader(headers, 'Status'), value: 'Operator_Replied' },
 { col: colLetterFromHeader(headers, 'Resolved_At'), value: ts },
 { col: colLetterFromHeader(headers, 'Operator_Reply'), value: operatorReply || '' },
 ];
 await updateRow(SHEETS.OPERATOR_INBOX, rowNum, colValues);
}

export async function getPostalZones() {
 const TTL_MS = 60 * 60 * 1000; // 60 minutes — never changes in normal operation
 if (_postalZoneCache && Date.now() - _postalZoneCacheAt < TTL_MS) return _postalZoneCache;
 _postalZoneCache = await readSheet(SHEETS.POSTAL_ZONES);
 _postalZoneCacheAt = Date.now();
 return _postalZoneCache;
}

export async function getServiceDurations() {
 const TTL_MS = 60 * 60 * 1000; // 60 minutes — never changes in normal operation
 if (_serviceDurCache && Date.now() - _serviceDurCacheAt < TTL_MS) return _serviceDurCache;
 _serviceDurCache = await readSheet(SHEETS.SERVICE_DURATIONS);
 _serviceDurCacheAt = Date.now();
 return _serviceDurCache;
}

export async function getTeamSchedule() {
  return readSheet(SHEETS.TEAM_SCHEDULE);
}

// ─── 9_Settings ───────────────────────────────────────────────────────
// Short-TTL cache (60 s) so setting changes take effect within a minute
// without hitting the Sheets API on every single call.
let _settingsCache = null;
let _settingsCacheAt = 0;
const SETTINGS_CACHE_TTL_MS = 60 * 1000;

export async function getSettings() {
  const now = Date.now();
  if (_settingsCache && (now - _settingsCacheAt) < SETTINGS_CACHE_TTL_MS) {
    return _settingsCache;
  }
  try {
    const rows = await readSheet(SHEETS.SETTINGS);
    const settings = {};
    for (const row of rows) {
      const key = (row.Setting || '').trim();
      if (key) settings[key] = row.Value ?? '';
    }
    _settingsCache = settings;
    _settingsCacheAt = now;
    return settings;
  } catch (e) {
    console.error('[sheets] getSettings failed, returning cached/defaults:', e.message);
    return _settingsCache || {};
  }
}

// Writes (or upserts) a single key→value pair in 9_Settings.
// If the Setting key already exists, the Value cell is updated in-place.
// If it does not exist yet, a new row is appended (self-initialising).
// In both cases the in-memory settings cache is invalidated so the
// next getSettings() call reflects the new value immediately.
export async function updateSettings(key, value) {
  const rows = await readSheet(SHEETS.SETTINGS);
  const headers = await getSheetHeaders(SHEETS.SETTINGS);
  const cfg = SHEET_CONFIG[SHEETS.SETTINGS];
  const dataStart = cfg.headerIdx + 1 + (cfg.skipAfterHeader || 0) + 1;

  const rowIdx = rows.findIndex(r => (r.Setting || '').trim() === key);

  if (rowIdx === -1) {
    // Key not present — append a new row so the sheet self-initialises.
    const rowData = buildRowFromHeaders(headers, {
      Setting: key,
      Value: String(value),
      Description: '',
    });
    await appendRow(SHEETS.SETTINGS, rowData);
  } else {
    // Key exists — update only the Value cell.
    const sheetRow = dataStart + rowIdx;
    const colValues = [{ col: colLetterFromHeader(headers, 'Value'), value: String(value) }];
    await updateRow(SHEETS.SETTINGS, sheetRow, colValues);
  }

  // Bust the cache so the very next getSettings() call reads the fresh value.
  _settingsCache = null;
  _settingsCacheAt = 0;
}

export async function getJobs() {
 const settings = await getSettings();
 const ttlMins = parseFloat(settings.Contact_Cache_TTL_Mins ?? '5');
 if (ttlMins === 0) return readSheet(SHEETS.JOBS);
 const ttlMs = ttlMins * 60 * 1000;
 if (_jobCache && Date.now() - _jobCacheAt < ttlMs) return _jobCache;
 _jobCache = await readSheet(SHEETS.JOBS);
 _jobCacheAt = Date.now();
 return _jobCache;
}

// ─── Module3_Queue ──────────────────────────────────────────────────────────────────

export async function getQueue() {
  return readSheet(SHEETS.QUEUE);
}

// Queue_ID format: Q-YYYYMMDD-NNN (exact clone of nextJobId logic, prefix Q- not JOB-)
async function nextQueueId() {
  const queue = await getQueue();
  const today = getSGTDate().replace(/-/g, '');
  const todayPrefix = `Q-${today}-`;
  const todayIds = queue
    .map(q => q.Queue_ID || '')
    .filter(id => id.startsWith(todayPrefix))
    .map(id => parseInt(id.slice(todayPrefix.length), 10))
    .filter(n => !isNaN(n));
  const next = todayIds.length > 0 ? Math.max(...todayIds) + 1 : 1;
  return `${todayPrefix}${String(next).padStart(3, '0')}`;
}

export async function addToQueue(fields) {
  const queueId = await nextQueueId();
  const now = getSGTDateTime();
  const headers = await getSheetHeaders(SHEETS.QUEUE);
  const rowData = {
    Queue_ID:       queueId,
    Contact_ID:     fields.Contact_ID     || '',
    Template_ID:    fields.Template_ID    || '',
    Generated_Date: fields.Generated_Date || now,
    Channel:        fields.Channel        || 'Telegram',
    Draft_Text:     fields.Draft_Text     || '',
  };
  const row = buildRowFromHeaders(headers, rowData);
  await appendRow(SHEETS.QUEUE, row);
  return queueId;
}

export async function findQueueById(queueId) {
  const rows = await getQueue();
  const dataStart = dataStartRowNum(SHEETS.QUEUE);
  const target = queueId.toUpperCase();
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i].Queue_ID || '').toUpperCase() === target) {
      return { id: rows[i].Queue_ID, rowNum: dataStart + i, row: rows[i] };
    }
  }
  return null;
}

// Looks up the numeric sheetId for a tab by title (needed for deleteDimension).
// Uses the same getSheets() auth pattern as all other functions here.
async function getSheetIdByTitle(title) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = (res.data.sheets || []).find(s => s.properties?.title === title);
  if (!sheet) throw new Error(`Sheet tab "${title}" not found`);
  return sheet.properties.sheetId;
}

export async function removeFromQueue(queueId) {
  const found = await findQueueById(queueId);
  if (!found) throw new Error(`Queue entry not found: ${queueId}`);
  const sheets = await getSheets();
  const sheetId = await getSheetIdByTitle(SHEETS.QUEUE);
  // rowNum is 1-based (sheet row number); deleteDimension startIndex is 0-based.
  const rowIndex = found.rowNum - 1;
  await queueWrite(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }],
    },
  }));
}

async function nextJobId() {
 const jobs = await getJobs();
 const today = getSGTDate().replace(/-/g, '');
 const todayPrefix = `JOB-${today}-`;
 const todayIds = jobs
 .map(j => j.Job_ID || '')
 .filter(id => id.startsWith(todayPrefix))
 .map(id => parseInt(id.slice(todayPrefix.length), 10))
 .filter(n => !isNaN(n));
 const next = todayIds.length > 0 ? Math.max(...todayIds) + 1 : 1;
 return `${todayPrefix}${String(next).padStart(3, '0')}`;
}

export async function hasReceivedTemplate(contactId, templateId) {
 const logs = await readSheet(SHEETS.MESSAGE_LOG);
 return logs.some(l =>
 l.Contact_ID === contactId &&
 (l.Template_ID || '') === templateId
 );
}

const PRICING_SERVICE_COLS = {
 GC: 'General Service',
 CW: 'Chemical Wash',
 CO: 'Chemical Overhaul',
 AS: 'Annual Service (4x)',
};

function parsePrice(s) {
 if (!s) return null;
 const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
 return isNaN(n) ? null : n;
}

export async function getPriceFromTable(serviceType, units) {
 const colName = PRICING_SERVICE_COLS[serviceType?.toUpperCase()];
 if (!colName) return 0;
 const rows = await readSheet(SHEETS.PRICING);
 const findRow = (label) => rows.find(r => String(r[''] ?? '').trim() === String(label).trim());
 if (units <= 5) {
 const row = findRow(String(units));
 return row ? (parsePrice(row[colName]) ?? 0) : 0;
 }
 const base = findRow('5');
 const extra = findRow('Units thereafter');
 if (!base || !extra) return 0;
 const basePrice = parsePrice(base[colName]) ?? 0;
 const extraRate = parsePrice(extra[colName]) ?? 0;
 return basePrice + (units - 5) * extraRate;
}

export async function getAreaFromPostal(postalCode) {
 if (!postalCode || postalCode.length < 2) return '';
 const sector = String(postalCode).slice(0, 2);
 const zones = await getPostalZones();
 const match = zones.find(z => String(z.Zone_ID || '').padStart(2, '0') === sector);
 if (!match) return '';
 return match.Zone_Name || '';
}

export async function createJob(data) {
 const now = getSGTDate();
 const jobId = await nextJobId();
 const headers = await getSheetHeaders(SHEETS.JOBS);
 const jobData = {
 Job_ID: jobId,
 Contact_ID: data.Contact_ID || '',
 Customer_Name: data.Customer_Name || '',
 Job_Date: data.Job_Date || now,
 Service_Type: data.Service_Type || '',
 Units_In_Home: data.Units || '',
 Units_Serviced: data.Units || '',
 Unit_Types: data.Unit_Types || '',
 Amount_SGD: data.Price_SGD || '',
 Payment_Status: 'Pending',
 Technician: data.Technician || '',
 Status: 'Scheduled',
 Booking_Source: 'Telegram',
 Contract_Job: 'FALSE',
 Address: data.Address || '',
 Notes: data.Notes || '',
 Created_Date: now,
 Slot_ID: data.Slot_ID || '',
 Calendar_Event_ID: data.Calendar_Event_ID || '',
 Team_ID: data.Team_ID || '',
 };
 const row = buildRowFromHeaders(headers, jobData);
 await appendRow(SHEETS.JOBS, row);
 return { Job_ID: jobId };
}

function colLetterFromHeader(headers, colName) {
 const idx = headers.indexOf(colName);
 if (idx === -1) throw new Error(`Column "${colName}" not found in sheet. Available: ${headers.join(', ')}`);
 return indexToCol(idx);
}

function indexToCol(idx) {
 let col = '';
 let n = idx;
 while (n >= 0) {
 col = String.fromCharCode((n % 26) + 65) + col;
 n = Math.floor(n / 26) - 1;
 }
 return col;
}

function getSGTDate() {
 return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

export function getSGTDateTime() {
 const fmt = new Intl.DateTimeFormat('en-CA', {
 timeZone: 'Asia/Singapore',
 year: 'numeric', month: '2-digit', day: '2-digit',
 hour: '2-digit', minute: '2-digit', hour12: false,
 });
 const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
 return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export async function getTeams() {
 const sheets = await getSheets();
 try {
 const res = await sheets.spreadsheets.values.get({
 spreadsheetId: SPREADSHEET_ID,
 range: '3D_Teams!A1:H50',
 });
 const rows = res.data.values || [];
 if (rows.length < 2) return [];

 const headers = rows[0];
 // Skip row 1 (description row), start from row 2 (index 2)
 return rows.slice(2)
 .filter(row => row.some(cell => cell?.trim()))
 .map(row => {
 const obj = {};
 headers.forEach((h, i) => { obj[h] = row[i] || ''; });
 return obj;
 });
 } catch (err) {
 // Sheet doesn't exist yet — return empty array
 // scheduler.js will fall back to hardcoded single calendar
 console.warn('[sheets] 3D_Teams not found:', err.message);
 return [];
 }
}

// ─── Tech App Workbook ────────────────────────────────────────────────────────

/**
 * getAppConfig — reads 1_App_Config from the tech app workbook.
 * Returns array of active field definitions ordered by Screen + Order.
 * Each row: { Field_ID, App_Label, Input_Type, Screen, Order, Required,
 * Options, CRM_Sheet, CRM_Column, Active, Notes }
 */
export async function getAppConfig() {
  const client = await getSheets();
  const res = await client.spreadsheets.values.get({
    spreadsheetId: TECH_APP_SPREADSHEET_ID,
    range: '1_App_Config!A1:K100',
  });
  const rows = res.data.values || [];
  // Find the header row (contains Field_ID)
  const headerIdx = rows.findIndex(r => r[0] === 'Field_ID');
  if (headerIdx === -1) throw new Error('[sheets] getAppConfig: header row not found in 1_App_Config');
  const headers = rows[headerIdx];
  const dataRows = rows.slice(headerIdx + 1).filter(r => r[0] && r[0].trim());
  return dataRows
    .map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] || ''])))
    .filter(r => r.Active === 'TRUE')
    .sort((a, b) => {
      if (a.Screen < b.Screen) return -1;
      if (a.Screen > b.Screen) return 1;
      return parseInt(a.Order || '0', 10) - parseInt(b.Order || '0', 10);
    });
}

/**
 * appendSubmission — writes a raw submission row to 3_Submissions
 * in the tech app workbook (audit log only).
 */
export async function appendSubmission(data) {
  const client = await getSheets();
  // Read headers from 3_Submissions row 1
  const headerRes = await client.spreadsheets.values.get({
    spreadsheetId: TECH_APP_SPREADSHEET_ID,
    range: '3_Submissions!1:1',
  });
  let headers = headerRes.data.values?.[0] || [];

  // If sheet is empty, write headers first
  if (headers.length === 0) {
    headers = ['Sub_ID', 'Job_ID', 'Contact_ID', 'Submitted_At', 'Raw_JSON', 'Sync_Status'];
    await client.spreadsheets.values.update({
      spreadsheetId: TECH_APP_SPREADSHEET_ID,
      range: '3_Submissions!1:1',
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }

  const row = headers.map(h => {
    if (h === 'Raw_JSON') return JSON.stringify(data);
    if (h === 'Submitted_At') return new Date().toISOString();
    if (h === 'Sync_Status') return 'Pending';
    return String(data[h] || '');
  });

  await client.spreadsheets.values.append({
    spreadsheetId: TECH_APP_SPREADSHEET_ID,
    range: '3_Submissions!A:A',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

/**
 * updateSubmissionStatus — marks a 3_Submissions row as Synced or Failed.
 */
export async function updateSubmissionStatus(subId, status) {
  const client = await getSheets();
  const res = await client.spreadsheets.values.get({
    spreadsheetId: TECH_APP_SPREADSHEET_ID,
    range: '3_Submissions!A:F',
  });
  const rows = res.data.values || [];
  const headers = rows[0] || [];
  const subIdCol = headers.indexOf('Sub_ID');
  const statusCol = headers.indexOf('Sync_Status');
  if (subIdCol === -1 || statusCol === -1) return;
  const rowIdx = rows.findIndex((r, i) => i > 0 && r[subIdCol] === subId);
  if (rowIdx === -1) return;
  const colLetter = String.fromCharCode(65 + statusCol);
  await client.spreadsheets.values.update({
    spreadsheetId: TECH_APP_SPREADSHEET_ID,
    range: `3_Submissions!${colLetter}${rowIdx + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] },
  });
}

