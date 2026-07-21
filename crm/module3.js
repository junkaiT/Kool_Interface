/**
 * module3.js — Automation engine for KoolAircon CRM
 *
 * Exports:
 * runDailyReminderSweep — daily Module 3 sweep (C+ND and L-anchor templates)
 * detectAndMarkCompletedJobs — stamps Completed_At, updates Last_Job_Date, queues POST-D0-A
 * cleanQueueStaleAndExpired — removes expired/stale/orphaned queue rows
 */

import {
 getTemplates,
 getContacts,
 getJobs,
 updateJob,
 updateContact,
 getSettings,
 updateSettings,
 getQueue,
 addToQueue,
 findQueueById,
 removeFromQueue,
 logMessage,
 getTemplate,
 getSGTDateTime,
 fillTemplate,
 getAppConfig,
 appendSubmission,
 updateSubmissionStatus,
} from './sheets.js';

import { sendTelegram, OPERATOR_TELEGRAM_ID } from './bot.js';
import { sendWhatsApp } from './whatsapp.js';

// ─── Step grammar helpers ─────────────────────────────────────────────────────

function parseStep(stepStr) {
 if (!stepStr || !stepStr.trim()) return null;
 const m = stepStr.trim().match(/^([A-Za-z]+)\+(\d+)([A-Za-z]+)$/);
 if (!m) return null;
 const [, anchor, offsetStr, unit] = m;
 return {
 anchor: anchor.toUpperCase(),
 offsetDays: parseInt(offsetStr, 10),
 unit: unit.toUpperCase(),
 };
}

function extractDateOnly(dateStr) {
 if (!dateStr) return null;
 const m = String(dateStr).match(/^(\d{4}-\d{2}-\d{2})/);
 return m ? m[1] : null;
}

function dateDiffDays(dateStrA, dateStrB) {
 const msA = new Date(dateStrA + 'T00:00:00Z').getTime();
 const msB = new Date(dateStrB + 'T00:00:00Z').getTime();
 return Math.round((msB - msA) / (24 * 60 * 60 * 1000));
}

// ─── cleanQueueStaleAndExpired ────────────────────────────────────────────────

export async function cleanQueueStaleAndExpired(
 todaySGT,
 parsedTemplates,
 lTemplates,
 contacts,
 contactsWithCompletedJob
) {
 const sleep = ms => new Promise(r => setTimeout(r, ms));
 const queue = await getQueue();
 if (queue.length === 0) {
 console.log('[module3] cleanQueueStaleAndExpired: queue empty, nothing to clean');
 return;
 }

 const tplMap = new Map();
 for (const { tpl, offsetDays } of parsedTemplates) {
 tplMap.set(tpl.Template_ID, { anchor: 'C', offsetDays });
 }
 for (const { tpl, offsetDays } of lTemplates) {
 tplMap.set(tpl.Template_ID, { anchor: 'L', offsetDays });
 }

 const contactMap = new Map(contacts.map(c => [c.Contact_ID, c]));
 let expiredCount = 0;
 let staleCount = 0;
 let deletedCount = 0;
 const toDelete = [];

 for (const row of queue) {
 let reason = null;

 const genDate = (row.Generated_Date || '').slice(0, 10);
 if (genDate) {
 const age = dateDiffDays(genDate, todaySGT);
 if (age > 14) { reason = 'expired'; expiredCount++; }
 }

 if (!reason) {
 const tplInfo = tplMap.get(row.Template_ID);
 if (tplInfo) {
 const contact = contactMap.get(row.Contact_ID);
 if (!contact) {
 reason = 'orphaned (contact not found)'; staleCount++;
 } else if (tplInfo.anchor === 'C') {
 const lastJobDateOnly = extractDateOnly(contact.Last_Job_Date || '');
 const daysSince = lastJobDateOnly ? dateDiffDays(lastJobDateOnly, todaySGT) : -1;
 if (daysSince !== tplInfo.offsetDays) {
 reason = `stale (C-anchor: daysSince=${daysSince}, expected=${tplInfo.offsetDays})`;
 staleCount++;
 }
 } else if (tplInfo.anchor === 'L') {
 const createdDate = (contact.Created_Date || '').slice(0, 10);
 const daysSinceCreated = createdDate ? dateDiffDays(createdDate, todaySGT) : -1;
 const hasCompletedJob = contactsWithCompletedJob.has(contact.Contact_ID);
 if (daysSinceCreated !== tplInfo.offsetDays || hasCompletedJob) {
 reason = `stale (L-anchor: daysSinceCreated=${daysSinceCreated}, expected=${tplInfo.offsetDays}, hasCompletedJob=${hasCompletedJob})`;
 staleCount++;
 }
 }
 }
 }

 if (reason) toDelete.push({ row, reason });
 }

 console.log(
 `[module3] cleanQueueStaleAndExpired: ${queue.length} rows checked,` +
 ` ${expiredCount} expired, ${staleCount} stale/orphaned, ${toDelete.length} to delete`
 );

 for (const { row, reason } of toDelete) {
 try {
 const found = await findQueueById(row.Queue_ID);
 if (found) {
 await removeFromQueue(found.id);
 deletedCount++;
 console.log(`[module3] cleanQueueStaleAndExpired: deleted ${row.Queue_ID} (${reason})`);
 }
 } catch (err) {
 console.error(`[module3] cleanQueueStaleAndExpired: error deleting ${row.Queue_ID}:`, err.message);
 }
 await sleep(1000);
 }

 console.log(`[module3] cleanQueueStaleAndExpired: done. Deleted ${deletedCount} rows.`);
}

// ─── detectAndMarkCompletedJobs ───────────────────────────────────────────────

export async function detectAndMarkCompletedJobs() {
 const jobs = await getJobs();
 const now = getSGTDateTime();
 const toProcess = jobs.filter(j => j.Status === 'Completed' && !j.Completed_At);

 if (toProcess.length === 0) return { processed: 0, results: [] };

 const contacts = await getContacts();
 const tpl = await getTemplate('POST-D0-A');
 const results = [];
 const lastJobMap = new Map();

 for (const job of toProcess) {
 stry {
 await updateJob(job.Job_ID, { Completed_At: now });

 if (job.Contact_ID) {
 const existing = lastJobMap.get(job.Contact_ID);
 if (!existing || now > existing) {
 lastJobMap.set(job.Contact_ID, now);
 }
 }

 const contact = contacts.find(c => c.Contact_ID === job.Contact_ID);
 const customerName = contact?.Full_Name || job.Customer_Name || 'Customer';

 if (contact?.Opt_Out === 'TRUE') {
 console.log(`[module3] detectAndMarkCompletedJobs: ${job.Contact_ID} is opted out — skipping POST-D0-A draft`);
 } else {
 let draftMsg = '(POST-D0-A template not found)';
 if (tpl) {
 draftMsg = fillTemplate(tpl.Message_Text, {
 Name: customerName,
 Service_Type: job.Service_Type || '',
 Units: job.Units_Serviced || job.Units_In_Home || '',
 Before_Photo_1: job.Before_Photo_1 || '',
 After_Photo_1: job.After_Photo_1 || '',
 });
 }

 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `✅ <b>Job completed detected: ${job.Job_ID}</b>\n` +
 `Customer: ${customerName} (${job.Contact_ID || 'unknown'})\n` +
 `Service: ${job.Service_Type || '?'} ×${job.Units_Serviced || job.Units_In_Home || '?'}\n` +
 `Completed_At: ${now}\n\n` +
 `📋 <b>POST-D0-A draft (NOT sent to customer — auto-send not active yet):</b>\n` +
 `─────────────────\n` +
 draftMsg +
 `\n─────────────────`
 );
 console.log(`[module3] Completion marked: ${job.Job_ID} (${customerName}) — draft preview sent to operator`);
 }

 results.push({ jobId: job.Job_ID, status: 'ok' });
 } catch (e) {
 results.push({ jobId: job.Job_ID, status: 'error', error: e.message });
 console.error(`[module3] detectAndMarkCompletedJobs error for ${job.Job_ID}:`, e.message);
 }
 }

 for (const [contactId, latestCompletedAt] of lastJobMap) {
 try {
 await updateContact(contactId, { Last_Job_Date: latestCompletedAt });
 } catch (e) {
 console.error(`[module3] Failed to update Last_Job_Date for ${contactId}:`, e.message);
 }
 }

 console.log(
 `[module3] detectAndMarkCompletedJobs: processed=${toProcess.length},` +
 ` ok=${results.filter(r => r.status === 'ok').length},` +
 ` errors=${results.filter(r => r.status === 'error').length},` +
 ` contacts_updated=${lastJobMap.size}`
 );
 return { processed: toProcess.length, results };
}

// ─── runDailyReminderSweep ────────────────────────────────────────────────────────

export async function runDailyReminderSweep() {
 const todaySGT = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

 const settings = await getSettings();
 const lastRunDate = (settings.Module3_Last_Run_Date || '').trim();
 if (lastRunDate === todaySGT) {
 console.log(`[module3] runDailyReminderSweep: already ran today (${todaySGT}), skipping`);
 return { skipped: true, reason: 'already_ran_today', date: todaySGT };
 }

 console.log(`[module3] runDailyReminderSweep: starting sweep for ${todaySGT}`);
 await updateSettings('Module3_Last_Run_Date', todaySGT);

 const allTemplates = await getTemplates();
 const scheduledTemplates = allTemplates.filter(
 t => t.Status === 'Active' && t.Trigger_Type === 'Scheduled'
 );

 if (scheduledTemplates.length === 0) {
 console.log('[module3] runDailyReminderSweep: no active scheduled templates found');
 return { skipped: false, draftsGenerated: 0, pairsChecked: 0 };
 }

 const parsedTemplates = [];
 for (const tpl of scheduledTemplates) {
 const parsed = parseStep(tpl.Step || '');
 if (!parsed || parsed.anchor !== 'C' || parsed.unit !== 'D') continue;
 parsedTemplates.push({ tpl, offsetDays: parsed.offsetDays });
 }

 const lTemplates = [];
 for (const tpl of scheduledTemplates) {
 const parsed = parseStep(tpl.Step || '');
 if (!parsed || parsed.anchor !== 'L') continue;
 let offsetDays;
 if (parsed.unit === 'D') {
 offsetDays = parsed.offsetDays;
 } else if (parsed.unit === 'HR') {
 offsetDays = Math.floor(parsed.offsetDays / 24);
 } else continue;
 lTemplates.push({ tpl, offsetDays });
 }

 if (parsedTemplates.length === 0 && lTemplates.length === 0) {
 console.log('[module3] runDailyReminderSweep: no C+ND or L-anchor templates after parsing');
 return { skipped: false, draftsGenerated: 0, pairsChecked: 0 };
 }

 const contacts = await getContacts();
 const optOutCount = contacts.filter(c => c.Opt_Out === 'TRUE').length;
 if (optOutCount > 0) console.log(`[module3] runDailyReminderSweep: skipping ${optOutCount} opted-out contact(s)`);
 const eligibleContacts = contacts.filter(
 c => c.Last_Job_Date && c.Last_Job_Date.trim() !== '' && c.Opt_Out !== 'TRUE'
 );

 let queue = await getQueue();
 const autoSend = (settings.Module3_AutoSend || '').toUpperCase() === 'TRUE';

 const allJobs = await getJobs();
 const contactsWithCompletedJob = new Set(
 allJobs.filter(j => j.Status === 'Completed').map(j => j.Contact_ID)
 );

 await cleanQueueStaleAndExpired(todaySGT, parsedTemplates, lTemplates, contacts, contactsWithCompletedJob);
 queue = await getQueue();

 let pairsChecked = 0;
 let draftsGenerated = 0;

 for (const { tpl, offsetDays } of parsedTemplates) {
 for (const contact of eligibleContacts) {
 pairsChecked++;
 const lastJobDateOnly = extractDateOnly(contact.Last_Job_Date);
 if (!lastJobDateOnly) continue;
 const daysSince = dateDiffDays(lastJobDateOnly, todaySGT);
 if (daysSince !== offsetDays) continue;

 const isDuplicate = queue.some(
 q => q.Contact_ID === contact.Contact_ID && q.Template_ID === tpl.Template_ID
 );
 if (isDuplicate) continue;

 const draftText = fillTemplate(tpl.Message_Text || '', {
 Name: contact.Full_Name || 'Customer',
 Contact_ID: contact.Contact_ID || '',
 Last_Job_Date: lastJobDateOnly,
 Phone: contact.Phone || '',
 Address: contact.Address || '',
 Email: contact.Email || '',
 });

 const queueChannel = (contact.Source || '').includes('WhatsApp') ? 'WhatsApp' : 'Telegram';

 if (autoSend) {
 try {
 if (queueChannel === 'WhatsApp') {
 await sendWhatsApp(contact.Contact_ID, draftText);
 } else {
 await sendTelegram(contact.Contact_ID, draftText);
 }
 await logMessage({
 Contact_ID: contact.Contact_ID,
 Direction: 'Outbound',
 Channel: queueChannel,
 Message_Text: draftText,
 Sent_By: 'Bot (Module3 AutoSend)',
 Status: 'Sent',
 });
 } catch (err) {
 console.error(`[module3] auto-send failed for ${contact.Contact_ID}:`, err.message);
 }
 } else {
 await addToQueue({
 Contact_ID: contact.Contact_ID,
 Template_ID: tpl.Template_ID,
 Channel: queueChannel,
 Draft_Text: draftText,
 });
 console.log(
 `[module3] queued ${tpl.Template_ID} for ${contact.Contact_ID}` +
 ` (${daysSince} days since last job on ${lastJobDateOnly})`
 );
 }
 draftsGenerated++;
 }
 }

 for (const { tpl, offsetDays } of lTemplates) {
 for (const contact of contacts) {
 if (contact.Opt_Out === 'TRUE') continue;
 if (!contact.Created_Date || !contact.Created_Date.trim()) continue;
 if (contactsWithCompletedJob.has(contact.Contact_ID)) continue;
 pairsChecked++;

 const daysSinceCreated = dateDiffDays(contact.Created_Date.slice(0, 10), todaySGT);
 if (daysSinceCreated !== offsetDays) continue;

 const isDuplicate = queue.some(
 q => q.Contact_ID === contact.Contact_ID && q.Template_ID === tpl.Template_ID
 );
 if (isDuplicate) continue;

 const draftText = fillTemplate(tpl.Message_Text || '', {
 Name: contact.Full_Name || 'Customer',
 Contact_ID: contact.Contact_ID || '',
 Phone: contact.Phone || '',
 Address: contact.Address || '',
 });

 const queueChannel = (contact.Source || '').includes('WhatsApp') ? 'WhatsApp' : 'Telegram';

 if (autoSend) {
 if (queueChannel === 'WhatsApp') {
 await sendWhatsApp(contact.Contact_ID, draftText);
 } else {
 await sendTelegram(contact.Contact_ID, draftText);
 }
 await logMessage({
 Contact_ID: contact.Contact_ID,
 Direction: 'Outbound',
 Channel: queueChannel,
 Message_Text: draftText,
 Sent_By: 'Bot (Module3 AutoSend)',
 Status: 'Sent',
 });
 } else {
 await addToQueue({
 Contact_ID: contact.Contact_ID,
 Template_ID: tpl.Template_ID,
 Channel: queueChannel,
 Draft_Text: draftText,
 });
 console.log(`[module3] queued ${tpl.Template_ID} for ${contact.Contact_ID} (${daysSinceCreated} days since created)`);
 }
 draftsGenerated++;
 }
 }

 const fullQueue = await getQueue();
 if (fullQueue.length === 0) {
 await sendTelegram(OPERATOR_TELEGRAM_ID, '📋 Module 3 daily sweep complete. No drafts pending.');
 } else {
 const lines = fullQueue.map((q, i) =>
 `${i + 1}. Q-${(q.Queue_ID || '').slice(-3)} — ${q.Contact_ID} — ${q.Template_ID} — ${q.Channel}`
 );
 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `📋 Module 3 sweep complete (${todaySGT}).\n${fullQueue.length} draft(s) pending approval:\n\n${lines.join('\n')}\n\nReply Q-NNN to send.`
 );
 }

 console.log(
 `[module3] runDailyReminderSweep: done — pairsChecked=${pairsChecked},` +
 ` draftsGenerated=${draftsGenerated}, templates=${parsedTemplates.length},` +
 ` eligibleContacts=${eligibleContacts.length}`
 );
 return { skipped: false, draftsGenerated, pairsChecked };
}

// ─── pollTechnicianSubmissions ──────────────────────────────────────────────────────

export async function pollTechnicianSubmissions() {
  const DRIVE_CREDS_PATH = '/home/ubuntu/.openclaw/workspace/.openclaw/secrets/gsheets-credentials.json';
  const { google } = await import('googleapis');
  const fs2 = await import('fs');

  const creds = JSON.parse(fs2.readFileSync(DRIVE_CREDS_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // Load already-processed file IDs from settings
  const settings = await getSettings();
  const processedRaw = (settings.Tech_Processed_Submissions || '').trim();
  const processed = new Set(processedRaw ? processedRaw.split(',').map(s => s.trim()) : []);

  // Find all _SUBMIT_ JSON files across all drives
  let files = [];
  try {
    const res = await drive.files.list({
      q: "name contains '_SUBMIT_' and mimeType = 'application/json' and trashed = false",
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id,name,createdTime)',
    });
    files = res.data.files || [];
  } catch (err) {
    console.error('[module3] pollTechnicianSubmissions: Drive list error:', err.message);
    return { processed: 0, errors: 1 };
  }

  const newFiles = files.filter(f => !processed.has(f.id));
  if (newFiles.length === 0) {
    console.log('[module3] pollTechnicianSubmissions: no new submissions');
    return { processed: 0, errors: 0 };
  }

  console.log(`[module3] pollTechnicianSubmissions: ${newFiles.length} new SUBMIT file(s) found`);

  // Load field config once — drives all routing decisions
  let appConfig = [];
  try {
    appConfig = await getAppConfig();
    console.log(`[module3] pollTechnicianSubmissions: loaded ${appConfig.length} active fields from 1_App_Config`);
  } catch (err) {
    console.error('[module3] pollTechnicianSubmissions: could not load App_Config:', err.message);
    return { processed: 0, errors: 1 };
  }

  // Build routing map: Field_ID → { CRM_Sheet, CRM_Column }
  const fieldRoutes = new Map();
  for (const field of appConfig) {
    if (field.Field_ID && field.CRM_Sheet && field.CRM_Column) {
      fieldRoutes.set(field.Field_ID, {
        sheet: field.CRM_Sheet,
        column: field.CRM_Column,
      });
    }
  }

  let processedCount = 0;
  let errorCount = 0;

  for (const file of newFiles) {
    try {
      // Read the SUBMIT JSON from Drive
      const content = await drive.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'text' }
      );
      const submit = typeof content.data === 'string'
        ? JSON.parse(content.data)
        : content.data;

      const jobId = submit.Job_ID;
      const contactId = submit.Contact_ID || '';

      if (!jobId) {
        console.warn('[module3] pollTechnicianSubmissions: SUBMIT missing Job_ID, skipping:', file.name);
        processed.add(file.id);
        continue;
      }

      // Write to 3_Submissions audit log first
      try {
        await appendSubmission({ ...submit, Sub_ID: submit.Sub_ID || file.id });
      } catch (err) {
        console.warn('[module3] pollTechnicianSubmissions: audit log write failed (non-fatal):', err.message);
      }

      // Route each field to the correct sheet + column using 1_App_Config
      const jobUpdates = {};
      const contactUpdates = {};

      for (const [fieldId, route] of fieldRoutes) {
        const aliases = {
          'arrived_confirm': 'Arrived_At',
          'units_in_home': 'Units_In_Home',
          'units_serviced': 'Units_Serviced',
          'cond_mould': 'Mould_Spotted',
          'cond_gas': 'Gas_Low',
          'cond_condenser': 'Condenser_Dirty',
          'cond_noise': 'Noise_Reported',
          'unit_age': 'Unit_Age_Years',
          'customer_mood': 'Customer_Mood',
          'unit_brand': 'Unit_Brand',
          'before_photo_1': 'Before_Photo_1',
          'before_photo_2': 'Before_Photo_2',
          'after_photo_1': 'After_Photo_1',
          'after_photo_2': 'After_Photo_2',
          'star_rating': 'Star_Rating',
        };
        const payloadKey = aliases[fieldId] || fieldId;
        const value = submit[payloadKey] ?? submit[fieldId];
        if (value === undefined || value === null || value === '') continue;

        if (route.sheet === '2_Jobs') {
          jobUpdates[route.column] = String(value);
        } else if (route.sheet === '1_Contacts') {
          contactUpdates[route.column] = String(value);
        }
      }

      // Always set these core job fields regardless of config
      jobUpdates.Status = 'Completed';
      jobUpdates.Completed_At = submit.Completed_At || new Date().toISOString();
      if (submit.Sub_ID || file.id) jobUpdates.Tech_Sub_ID = submit.Sub_ID || file.id;

      // Write to 2_Jobs
      try {
        await updateJob(jobId, jobUpdates);
        console.log(`[module3] pollTechnicianSubmissions: job ${jobId} updated — ${Object.keys(jobUpdates).length} fields`);
      } catch (err) {
        console.error(`[module3] pollTechnicianSubmissions: updateJob failed for ${jobId}:`, err.message);
        await updateSubmissionStatus(submit.Sub_ID || file.id, 'Failed: ' + err.message);
        errorCount++;
        continue;
      }

      // Write to 1_Contacts if any contact-level fields were collected
      if (contactId && Object.keys(contactUpdates).length > 0) {
        try {
          await updateContact(contactId, contactUpdates);
          console.log(`[module3] pollTechnicianSubmissions: contact ${contactId} updated — ${Object.keys(contactUpdates).length} fields`);
        } catch (err) {
          console.warn(`[module3] pollTechnicianSubmissions: updateContact failed for ${contactId}:`, err.message);
        }
      }

      // Fire detectAndMarkCompletedJobs — handles Last_Job_Date + POST-D0-A
      try {
        await detectAndMarkCompletedJobs();
      } catch (err) {
        console.error('[module3] pollTechnicianSubmissions: detectAndMarkCompletedJobs error:', err.message);
      }

      // Mark submission as synced
      try {
        await updateSubmissionStatus(submit.Sub_ID || file.id, 'Synced');
      } catch (err) { /* non-fatal */ }

      processed.add(file.id);
      processedCount++;

    } catch (err) {
      console.error('[module3] pollTechnicianSubmissions: error processing', file.name, ':', err.message);
      errorCount++;
    }
  }

  // Persist processed set
  try {
    await updateSettings('Tech_Processed_Submissions', [...processed].join(','));
  } catch (err) {
    console.error('[module3] pollTechnicianSubmissions: failed to save processed set:', err.message);
  }

  console.log(`[module3] pollTechnicianSubmissions: done — processed=${processedCount}, errors=${errorCount}`);
  return { processed: processedCount, errors: errorCount };
}

