/**
 * reports.js — Service report assembly and photo bundle delivery
 *
 * Responsibilities:
 * assemblePhotoBundleSequence(job) — builds ordered asset list from job record
 * sendPhotoBundleToCustomer(job, contact) — uploads assets to Meta, sends in sequence
 * compilePostD0B(job, contact) — builds closing text with report link + flags
 *
 * This module is intentionally isolated from CRM logic. If something breaks
 * in report delivery, only this file needs fixing — no impact on booking,
 * scheduling, or CRM write paths.
 *
 * Called by:
 * crm.js — on YES reply detection or /sendphotos command
 * module3.js — never called directly (reports.js handles its own sends)
 */

import {
  getJobs,
  getContacts,
  getTemplate,
  fillTemplate,
  updateJob,
  getSettings,
  logMessage,
} from './sheets.js';

import {
  uploadWhatsAppMedia,
  sendWhatsAppMedia,
  sendWhatsApp,
} from './whatsapp.js';

import { sendTelegram, OPERATOR_TELEGRAM_ID } from './bot.js';

// ── Sleep helper ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── assemblePhotoBundleSequence ───────────────────────────────────────────────
/**
 * Builds the ordered list of assets to send for a completed job.
 * Returns array of { type, driveUrl, caption } objects.
 * Only includes assets that have a non-empty Drive URL in the job record.
 */
export function assemblePhotoBundleSequence(job) {
  const sequence = [];

  // Before/after pairs — interleaved by unit for maximum impact
  // Unit 1
  if (job.Before_Photo_1) {
    sequence.push({
      type: 'image',
      driveUrl: job.Before_Photo_1,
      caption: `Before${job.Unit_1_Room ? ` — ${job.Unit_1_Room}` : ' — Unit 1'}`,
    });
  }
  if (job.After_Photo_1) {
    sequence.push({
      type: 'image',
      driveUrl: job.After_Photo_1,
      caption: `After${job.Unit_1_Room ? ` — ${job.Unit_1_Room}` : ' — Unit 1'}`,
    });
  }

  // Unit 2
  if (job.Before_Photo_2) {
    sequence.push({
      type: 'image',
      driveUrl: job.Before_Photo_2,
      caption: `Before${job.Unit_2_Room ? ` — ${job.Unit_2_Room}` : ' — Unit 2'}`,
    });
  }
  if (job.After_Photo_2) {
    sequence.push({
      type: 'image',
      driveUrl: job.After_Photo_2,
      caption: `After${job.Unit_2_Room ? ` — ${job.Unit_2_Room}` : ' — Unit 2'}`,
    });
  }

  // Dust photos
  if (job.Dust_Photo_1) {
    sequence.push({
      type: 'image',
      driveUrl: job.Dust_Photo_1,
      caption: `Extracted from ${job.Unit_1_Room || 'Unit 1'}`,
    });
  }
  if (job.Dust_Photo_2) {
    sequence.push({
      type: 'image',
      driveUrl: job.Dust_Photo_2,
      caption: `Extracted from ${job.Unit_2_Room || 'Unit 2'}`,
    });
  }

  // Dirty water video — always last in sequence for maximum impact
  if (job.Dirty_Water_Video_URL) {
    sequence.push({
      type: 'video',
      driveUrl: job.Dirty_Water_Video_URL,
      caption: `Drain pan — ${job.Job_Date || 'today'}`,
    });
  }

  return sequence;
}

// ── compilePostD0B ────────────────────────────────────────────────────────────
/**
 * Builds the closing text message sent after the photo bundle.
 * Includes report link and condition flags if any were raised.
 */
export async function compilePostD0B(job, contact) {
  const settings = await getSettings();
  const reportBaseUrl = settings.URL_Report || 'https://kool.com.sg/report';
  const reportToken = job.Report_Token || job.Job_ID;

  const tpl = await getTemplate('POST-D0-B');
  let closingText = tpl?.Message_Text
    ? fillTemplate(tpl.Message_Text, { report_token: reportToken })
    : `Your full service summary is here:\n${reportBaseUrl}/${reportToken}\n\nAny questions, just reply here.`;

  // Append condition flags if any were raised
  const flags = [];
  if (job.Mould_Spotted === 'TRUE') flags.push('Our technician flagged mould on one or more units.');
  if (job.Gas_Low === 'TRUE') flags.push('Your unit may be low on gas.');
  if (job.Condenser_Dirty === 'TRUE') flags.push('Your outdoor condenser needs attention.');
  if (job.Noise_Reported === 'TRUE') flags.push('Unusual noise was detected from one or more units.');

  if (flags.length > 0) {
    closingText +=
      '\n\nOur technician flagged a few things worth your attention — ' +
      'details are in your service summary.\n\n' +
      flags.map(f => `• ${f}`).join('\n');
  }

  return closingText;
}

// ── fetchDriveFileAsBuffer ────────────────────────────────────────────────────
/**
 * Fetches a Google Drive file as a buffer using the service account.
 * Drive URLs from the app are in format: https://drive.google.com/uc?export=view&id=FILE_ID
 */
async function fetchDriveFileAsBuffer(driveUrl) {
  const { google } = await import('googleapis');
  const fs = await import('fs');
  const CREDS_PATH = '/home/ubuntu/.openclaw/workspace/.openclaw/secrets/gsheets-credentials.json';
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  // Extract file ID from Drive URL
  const match = driveUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
    driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error(`[reports] Cannot extract file ID from URL: ${driveUrl}`);
  const fileId = match[1];

  // Get file metadata for mime type
  const meta = await drive.files.get({
    fileId,
    fields: 'name,mimeType',
    supportsAllDrives: true,
  });

  // Download file content
  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );

  return {
    buffer: Buffer.from(response.data),
    mimeType: meta.data.mimeType || 'image/jpeg',
    filename: meta.data.name || `file_${fileId}`,
  };
}

// ── sendPhotoBundleToCustomer ─────────────────────────────────────────────────
/**
 * Main entry point for photo bundle delivery.
 * Called by crm.js on YES reply or /sendphotos command.
 *
 * Flow:
 * 1. Assemble sequence from job record
 * 2. Send intro text (POST-D0-A)
 * 3. For each asset: fetch from Drive → upload to Meta → send to customer
 * 4. Send closing text (POST-D0-B) with report link and flags
 * 5. Update Photos_Sent = TRUE on job
 * 6. Log all sends
 *
 * @param {string} jobId — Job_ID from 2_Jobs
 * @param {string} contactChannelId — customer's WhatsApp number
 * @param {boolean} operatorInitiated — true if triggered by /sendphotos command
 */
export async function sendPhotoBundleToCustomer(jobId, contactChannelId, operatorInitiated = false) {
  console.log(`[reports] sendPhotoBundleToCustomer: ${jobId} → ${contactChannelId}`);

  // Load job and contact
  const jobs = await getJobs();
  const job = jobs.find(j => j.Job_ID === jobId);
  if (!job) throw new Error(`[reports] Job not found: ${jobId}`);

  const contacts = await getContacts();
  const contact = contacts.find(c => c.Contact_ID === job.Contact_ID);
  if (!contact) throw new Error(`[reports] Contact not found for job: ${jobId}`);

  // Check not already sent
  if (job.Photos_Sent === 'TRUE' && !operatorInitiated) {
    console.log(`[reports] Photos already sent for ${jobId} — skipping`);
    return { skipped: true, reason: 'already_sent' };
  }

  const sequence = assemblePhotoBundleSequence(job);
  if (sequence.length === 0) {
    console.warn(`[reports] No assets found for ${jobId} — cannot send bundle`);
    await sendTelegram(
      OPERATOR_TELEGRAM_ID,
      `⚠️ <b>/sendphotos ${jobId}</b> — no photos or videos found on this job record.\n` +
      `Check that the technician app uploaded assets correctly.`
    );
    return { skipped: true, reason: 'no_assets' };
  }

  const errors = [];
  let sentCount = 0;

  // Step 1 — Send intro text (POST-D0-A)
  const introTpl = await getTemplate('POST-D0-A');
  const introText = introTpl?.Message_Text || 'Here are your service photos from today, organised by room.';
  try {
    await sendWhatsApp(contactChannelId, introText);
    await logMessage({
      Contact_ID: contact.Contact_ID,
      Direction: 'Outbound',
      Channel: 'WhatsApp',
      Message_Text: introText,
      Template_ID: 'POST-D0-A',
      Sent_By: operatorInitiated ? 'Operator (/sendphotos)' : 'Bot (Auto YES)',
      Status: 'Sent',
    });
    await sleep(1500);
  } catch (err) {
    console.error('[reports] Failed to send intro text:', err.message);
    errors.push({ step: 'intro', error: err.message });
  }

  // Step 2 — Send each asset
  for (const asset of sequence) {
    try {
      console.log(`[reports] Fetching from Drive: ${asset.caption}`);
      const { buffer, mimeType, filename } = await fetchDriveFileAsBuffer(asset.driveUrl);

      console.log(`[reports] Uploading to Meta: ${filename} (${mimeType})`);
      const mediaId = await uploadWhatsAppMedia(buffer, mimeType, filename);

      console.log(`[reports] Sending to customer: ${asset.caption}`);
      await sendWhatsAppMedia(contactChannelId, asset.type, mediaId, asset.caption);

      await logMessage({
        Contact_ID: contact.Contact_ID,
        Direction: 'Outbound',
        Channel: 'WhatsApp',
        Message_Text: `[${asset.type.toUpperCase()}] ${asset.caption}`,
        Sent_By: operatorInitiated ? 'Operator (/sendphotos)' : 'Bot (Auto YES)',
        Status: 'Sent',
      });

      sentCount++;
      await sleep(2000);
    } catch (err) {
      console.error(`[reports] Failed to send asset "${asset.caption}":`, err.message);
      errors.push({ step: asset.caption, error: err.message });
    }
  }

  // Step 3 — Send closing text (POST-D0-B)
  try {
    const closingText = await compilePostD0B(job, contact);
    await sendWhatsApp(contactChannelId, closingText);
    await logMessage({
      Contact_ID: contact.Contact_ID,
      Direction: 'Outbound',
      Channel: 'WhatsApp',
      Message_Text: closingText,
      Template_ID: 'POST-D0-B',
      Sent_By: operatorInitiated ? 'Operator (/sendphotos)' : 'Bot (Auto YES)',
      Status: 'Sent',
    });
  } catch (err) {
    console.error('[reports] Failed to send closing text:', err.message);
    errors.push({ step: 'closing', error: err.message });
  }

  // Step 4 — Update Photos_Sent on job
  try {
    await updateJob(jobId, { Photos_Sent: 'TRUE' });
  } catch (err) {
    console.error('[reports] Failed to update Photos_Sent:', err.message);
  }

  // Step 5 — Notify operator
  const statusLine = errors.length > 0
    ? `⚠️ ${sentCount} sent, ${errors.length} failed: ${errors.map(e => e.step).join(', ')}`
    : `✅ ${sentCount} asset(s) sent successfully`;

  await sendTelegram(
    OPERATOR_TELEGRAM_ID,
    `📸 <b>Photo bundle — ${jobId}</b>\n` +
    `Customer: ${contact.Full_Name} (${contact.Contact_ID})\n` +
    statusLine
  );

  console.log(`[reports] Bundle complete: sent=${sentCount}, errors=${errors.length}`);
  return { sent: sentCount, errors };
}
