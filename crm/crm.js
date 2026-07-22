/**
 * crm.js — Customer-facing message handlers for KoolAircon CRM
 *
 * Exports:
 * handleInboundMessage — processes all inbound customer messages
 * handleInfoCommand — /info command: save/update contact details
 * handleOperatorApproval — INBOX-NNN approval: send draft to customer
 * handleQueueApproval — Q-NNN approval: send Module 3 draft
 * isQueueApprovalText — detects Q-NNN pattern in operator input
 */

import {
 findContactByChannelId,
 createContact,
 updateContact,
 getTemplate,
 fillTemplate,
 logMessage,
 addToInbox,
 appendToInbox,
 findOpenInboxForContact,
 findInboxById,
 resolveInbox,
 createJob,
 updateContact as updateContactAlias,
 getContacts,
 getJobs,
 hasReceivedTemplate,
 getAreaFromPostal,
 getSGTDateTime,
 getQueue,
 findQueueById,
 removeFromQueue,
} from './sheets.js';

import {
 getZoneFromPostal,
 serviceTypeLabel,
 getTeamCalendars,
 parseHHMM,
} from './scheduler.js';

import {
 createEvent as calCreateEvent,
 updateEvent as calUpdateEvent,
 buildDescription as calBuildDescription,
 buildTitle as calBuildTitle,
 ZONE_COLOR,
} from './calendar.js';

import {
 sendTelegram,
 OPERATOR_TELEGRAM_ID,
 pendingApprovals,
} from './bot.js';

import { sendWhatsApp } from './whatsapp.js';
import { normalizeInboxId } from './booking.js';
import { sendPhotoBundleToCustomer } from './reports.js';
import * as db from './db.js';

// ─── Local helpers ────────────────────────────────────────────────────────────

function sgtDateAtMinutes(dateStr, mins) {
 const hh = String(Math.floor(mins / 60)).padStart(2, '0');
 const mm = String(mins % 60).padStart(2, '0');
 return new Date(`${dateStr}T${hh}:${mm}:00+08:00`);
}

// ─── Booking intent detection ─────────────────────────────────────────────────

const BOOKING_KEYWORDS = [
 'book', 'schedule', 'available', 'availability',
 'appt', 'appointment', 'slot', 'when', 'date',
];

const CONTACT_INFO_REGEX = /address\s*[:\-]?\s*(.+?)[\r\n]+postal\s*(?:code)?\s*[:\-]?\s*(\d{6})[\r\n]+phone\s*(?:number)?\s*[:\-]?\s*([\d\s\+\-]+)/i;

function hasBookingIntent(text) {
 const lower = (text || '').toLowerCase();
 return BOOKING_KEYWORDS.some(kw => lower.includes(kw));
}

function parseContactInfo(text) {
 const match = text.match(CONTACT_INFO_REGEX);
 if (!match) return null;
 return {
 address: match[1].trim(),
 postalCode: match[2].trim(),
 phone: match[3].trim(),
 };
}


// ─── YES reply detection ──────────────────────────────────────────────────────

const YES_PATTERNS = [
  /^yes$/i, /^ok$/i, /^okay$/i, /^sure$/i, /^send$/i,
  /^yep$/i, /^yeah$/i, /^ya$/i, /^yup$/i,
  /^send it$/i, /^yes please$/i, /^please send$/i,
  /^send me$/i, /^send the photos$/i, /^send photos$/i,
];

// Auto-detect clear YES replies (short, unambiguous)
export function isPhotoYesReply(text) {
  if (!text) return false;
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > 4) return false;
  return YES_PATTERNS.some(p => p.test(trimmed));
}

// Detect probable YES — longer messages that likely mean yes but need operator nudge
export function isProbablePhotoYesReply(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    (lower.includes('yes') || lower.includes('send') || lower.includes('sure') ||
    lower.includes('okay') || lower.includes('go ahead') || lower.includes('sounds good')) &&
    !lower.includes('?') &&
    !lower.includes('when') &&
    !lower.includes('how')
  );
}

// ─── handleSendPhotosCommand ──────────────────────────────────────────────────

export async function handleSendPhotosCommand(inboxId) {
  const normalized = normalizeInboxId(inboxId);
  if (!normalized) {
    return { success: false, message: '⚠️ Invalid inbox ID. Usage: /sendphotos INBOX-001' };
  }

  const { findInboxById, getJobs, getContacts } = await import('./sheets.js');
  const inboxRow = await findInboxById(normalized);
  if (!inboxRow) {
    return { success: false, message: `⚠️ No inbox found for ${normalized}` };
  }

  const contactId = inboxRow.row.Contact_ID;
  const jobs = await getJobs();
  const job = jobs
    .filter(j => j.Contact_ID === contactId && j.Status === 'Completed')
    .sort((a, b) => (b.Job_Date || '').localeCompare(a.Job_Date || ''))
    [0];

  if (!job) {
    return {
      success: false,
      message: `⚠️ No completed job found for ${normalized} (Contact: ${contactId}). Check that the job is marked Completed in 2_Jobs.`,
    };
  }

  if (job.Photos_Sent === 'TRUE') {
    await sendTelegram(
      OPERATOR_TELEGRAM_ID,
      `ℹ️ Photos already sent for ${job.Job_ID}. Send again?
` +
      `Reply <code>/sendphotos ${normalized} force</code> to resend.`
    );
    return { success: false, reason: 'already_sent' };
  }

  await sendTelegram(
    OPERATOR_TELEGRAM_ID,
    `📸 Sending photo bundle for ${job.Job_ID} to ${contactId}...`
  );

  const contacts = await getContacts();
  const contact = contacts.find(c => c.Contact_ID === contactId);
  const channelId = contact?.Channel_Contact_ID || contact?.Phone;

  if (!channelId) {
    return { success: false, message: `⚠️ No WhatsApp channel ID for ${contactId}. Check 1_Contacts.` };
  }

  await sendPhotoBundleToCustomer(job.Job_ID, channelId, true);
  return { success: true, jobId: job.Job_ID };
}

// ─── handleInboundMessage ─────────────────────────────────────────────────────

export async function handleInboundMessage(msg) {
 const { contactId, text, timestamp, senderName, channel = 'Telegram' } = msg;
 const ts = timestamp || new Date().toISOString();

 console.log(`[crm] Inbound from ${contactId}: ${text}`);

 let contact = await findContactByChannelId(contactId);
 if (!contact) {
 const displayName = senderName || (channel === 'WhatsApp' ? `WA-${contactId}` : `TG-${contactId}`);
 contact = await createContact({
 Full_Name: displayName,
 Channel_Contact_ID: contactId,
 Source: channel === 'WhatsApp' ? 'WhatsApp Inbound' : 'Telegram Inbound',
 });
 console.log(`[crm] Created new contact: ${contact.Contact_ID}`);
 }

 await logMessage({
 Contact_ID: contact.Contact_ID,
 Direction: 'Inbound',
 Channel: channel,
 Message_Text: text,
 Sent_By: contact.Full_Name || contactId,
 Status: 'Received',
 });

 await db.insert({
 conversation_id: String(contactId),
 channel: channel.toLowerCase(),
 direction: 'inbound',
 message_type: 'direct',
 text,
 sender: String(contactId),
 }).catch(e => console.error('[crm] db log failed:', e.message));


  // ── Check if this is a YES reply to POST-D0-UTIL photo bundle offer ───────
  if (isPhotoYesReply(text)) {
    const jobs = await getJobs();
    const pendingPhotoJob = jobs.find(j =>
      j.Contact_ID === contact.Contact_ID &&
      j.Status === 'Completed' &&
      j.Post_Job_Sent === 'TRUE' &&
      j.Photos_Sent !== 'TRUE'
    );
    if (pendingPhotoJob) {
      console.log(`[crm] YES reply detected — auto-sending photo bundle for ${pendingPhotoJob.Job_ID}`);
      await sendTelegram(
        OPERATOR_TELEGRAM_ID,
        `📸 <b>YES reply — auto-sending photo bundle</b>\n` +
        `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n` +
        `Job: ${pendingPhotoJob.Job_ID}`
      );
      sendPhotoBundleToCustomer(pendingPhotoJob.Job_ID, contactId, false).catch(err =>
        console.error('[crm] Auto photo bundle error:', err.message)
      );
      return { success: true, contactId: contact.Contact_ID, action: 'photo_bundle_triggered' };
    }
  }

  // ── Check if probable YES — notify operator for manual decision ───────────
  if (isProbablePhotoYesReply(text)) {
    const jobs = await getJobs();
    const pendingPhotoJob = jobs.find(j =>
      j.Contact_ID === contact.Contact_ID &&
      j.Status === 'Completed' &&
      j.Post_Job_Sent === 'TRUE' &&
      j.Photos_Sent !== 'TRUE'
    );
    if (pendingPhotoJob) {
      const inboxId = (await findOpenInboxForContact(contact.Contact_ID))?.inboxId || '?';
      await sendTelegram(
        OPERATOR_TELEGRAM_ID,
        `📸 <b>Possible YES to photo bundle</b>\n` +
        `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n` +
        `Job: ${pendingPhotoJob.Job_ID}\n` +
        `Customer said: "${text}"\n\n` +
        `<code>/sendphotos ${inboxId}</code> — send photo bundle\n` +
        `<code>${inboxId} your reply</code> — reply with custom message instead`
      );
      return { success: true, contactId: contact.Contact_ID, action: 'probable_yes_flagged' };
    }
  }


  // ── Detect structured web booking message ─────────────────────────────────
  const WEB_BOOKING_PREFIX = "Hi KoolAircon! I'd like to book an aircon service.";
  if (text.startsWith(WEB_BOOKING_PREFIX)) {
    try {
      const extract = (label) => {
        const match = text.match(new RegExp(label + ':\\s*(.+)'));
        return match ? match[1].trim() : '';
      };
      const parsedName = extract('Name');
      const parsedService = extract('Service')?.match(/^([A-Z]+)/)?.[1] || '';
      const parsedUnits = parseInt(extract('Service')?.match(/×\s*(\d+)/)?.[1] || '1', 10);
      const parsedSlot = extract('Requested slot');
      const parsedAddress = extract('Address');
      const parsedPostal = extract('Postal code');

      const updateFields = { Last_Updated: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) };
      if (parsedName && parsedName !== contact.Full_Name) updateFields.Full_Name = parsedName;
      if (parsedAddress) updateFields.Address = parsedAddress;
      if (parsedPostal) updateFields.Postal_Code = parsedPostal;
      if (parsedService) updateFields.Contact_Status = 'Lead';
      updateFields.Source = 'Web Booking';

      await updateContact(contact.Contact_ID, updateFields);
      Object.assign(contact, updateFields);

      let zoneId = '';
      try {
        const { getZoneFromPostal } = await import('./scheduler.js');
        const zone = await getZoneFromPostal(parsedPostal);
        zoneId = zone?.Zone_ID || '';
      } catch (e) { /* non-fatal */ }

      const webInboxId = await addToInbox({
        Contact_ID: contact.Contact_ID,
        Contact_Name: parsedName || contact.Full_Name,
        Customer_Message: text,
        Draft_Reply: '(awaiting operator confirmation)',
        Channel: 'WhatsApp',
        Status: 'Pending',
      });

      const found = await findOpenInboxForContact(contact.Contact_ID);
      const webRowNum = found?.rowNum;

      pendingApprovals.set(webInboxId, {
        inboxId: webInboxId,
        rowNum: webRowNum,
        contact,
        contactChannelId: contactId,
        draftReply: '(awaiting operator confirmation)',
        customerMessage: text,
        timestamp: new Date().toISOString(),
        webBookingRequest: {
          service: parsedService,
          units: parsedUnits,
          slot: parsedSlot,
          address: parsedAddress,
          postal: parsedPostal,
          zoneId,
        },
      });

      const svcLabels = { GC: 'General Clean', CW: 'Chemical Wash', CO: 'Chemical Overhaul', KJ: 'KoolJet', AS: 'Annual Service' };
      const svcLabel = svcLabels[parsedService] || parsedService;

      await sendTelegram(
        OPERATOR_TELEGRAM_ID,
        `📅 <b>Web booking request — ${webInboxId}</b>\n` +
        `Name: ${parsedName || contact.Full_Name}\n` +
        `Phone: ${contactId}\n` +
        `Address: ${parsedAddress}\n` +
        `Postal: ${parsedPostal}${zoneId ? ` (Zone ${zoneId})` : ''}\n` +
        `Service: ${svcLabel} × ${parsedUnits} unit(s)\n` +
        `Requested slot: <b>${parsedSlot}</b>\n\n` +
        `Contact details saved to CRM. Run:\n` +
        `<code>/b ${webInboxId} ${parsedService} ${parsedUnits}</code>\n` +
        `Select the slot closest to ${parsedSlot}\n\n` +
        `If slot unavailable:\n` +
        `<code>${webInboxId} Hi ${(parsedName || contact.Full_Name).split(' ')[0]}, unfortunately that slot is no longer available. Here are the next options:</code>`
      );

      return {
        success: true,
        contactId: contact.Contact_ID,
        inboxId: webInboxId,
        action: 'web_booking_parsed',
      };
    } catch (err) {
      console.error('[crm] Web booking parse error:', err.message);
      // Fall through to normal handling if parse fails
    }
  }

 async function getLeadInitTemplate() {
 const tpl = await getTemplate('LEAD-INIT-A');
 if (tpl && tpl.Message_Text) {
 return fillTemplate(tpl.Message_Text, { Name: contact.Full_Name });
 }
 return (
 `Hi [${contact.Full_Name}]! Thanks for reaching out to KoolAircon 😊\n\n` +
 `Here's our pricing and services at this link: https://kool.com.sg/our-price/\n\n` +
 `Please provide the following information:\n` +
 `Address:\n` +
 `Postal Code:\n` +
 `Phone Number:\n\n` +
 `We will get back to you soon!\n\n` +
 `Reply STOP to unsubscribe.`
 );
 }

 const existing = await findOpenInboxForContact(contact.Contact_ID);
 const alreadyLeadInited = await hasReceivedTemplate(contact.Contact_ID, 'LEAD-INIT-A');
 const isTest = String(contactId).startsWith('TEST-');

 let draftReply;
 let autoSent = false;
 let autoTemplateId = null;
 let followUpDraft = null;

 if (!alreadyLeadInited) {
 draftReply = await getLeadInitTemplate();
 autoTemplateId = 'LEAD-INIT-A';
 autoSent = true;
 if (contact.Opt_Out === 'TRUE') {
 console.log(`[crm] handleInboundMessage: ${contactId} is opted out — skipping LEAD-INIT-A auto-send`);
 autoSent = false;
 } else if (!isTest) {
 try {
 channel === 'WhatsApp'
 ? await sendWhatsApp(contactId, draftReply)
 : await sendTelegram(contactId, draftReply);
 } catch (e) { console.error('[crm] auto-send failed:', e.message); autoSent = false; }
 }
 await logMessage({
 Contact_ID: contact.Contact_ID,
 Direction: 'Outbound',
 Channel: channel,
 Message_Text: draftReply,
 Template_ID: autoTemplateId,
 Sent_By: 'Bot (Auto LEAD-INIT-A)',
 Status: autoSent ? 'Sent' : 'Failed',
 });
 } else {
 autoSent = false;
 const parsedInfo = parseContactInfo(text);

 if (parsedInfo) {
 draftReply = `Hi ${contact.Full_Name}! Thanks for sharing your details. We'll be in touch soon to confirm your appointment! 😊`;
 followUpDraft = draftReply;
 } else if (hasBookingIntent(text)) {
 draftReply =
 `Thanks for your message! To get started, please share:\n` +
 `Address:\n` +
 `Postal Code:\n` +
 `Phone Number:\n\n` +
 `We'll get back to you with available slots shortly! 😊`;
 followUpDraft = draftReply;
 } else {
 draftReply = `Hi ${contact.Full_Name}! Thanks for your message. We'll get back to you shortly 😊`;
 followUpDraft = draftReply;
 }
 }

 const inboxDraft = followUpDraft || draftReply;
 const needsOperatorReview = !!followUpDraft;
 let inboxId, rowNum, isFollowUp = false;

 if (existing) {
 inboxId = existing.inboxId;
 rowNum = existing.rowNum;
 isFollowUp = true;
 await appendToInbox(rowNum, text, inboxDraft, existing.row);
 console.log(`[crm] Appended to inbox ${inboxId} (row ${rowNum}) for ${contact.Contact_ID}`);
 } else {
 inboxId = await addToInbox({
 Contact_ID: contact.Contact_ID,
 Contact_Name: contact.Full_Name,
 Customer_Message: text,
 Draft_Reply: inboxDraft,
 Channel: channel,
 Status: needsOperatorReview ? 'Pending' : 'Auto_Replied',
 });
 const found = await findOpenInboxForContact(contact.Contact_ID);
 rowNum = found?.rowNum;
 console.log(`[crm] Created inbox ${inboxId} (row ${rowNum}) for ${contact.Contact_ID}`);
 }

 const parsedInfo = parseContactInfo(text);
 if (needsOperatorReview || parsedInfo) {
 const entry = {
 inboxId, rowNum, contact,
 contactChannelId: contactId,
 draftReply: inboxDraft,
 customerMessage: text,
 timestamp: ts,
 };
 if (parsedInfo) entry.detectedContactInfo = parsedInfo;
 pendingApprovals.set(inboxId, entry);
 }

 const followUpTag = isFollowUp ? ' (follow-up)' : '';
 const sendStatus = autoSent ? '✅ Auto-sent' : '⚠️ Auto-send FAILED';
 let operatorMsg;

 if (!needsOperatorReview && !parsedInfo) {
 operatorMsg =
 `📥 <b>${inboxId}${followUpTag}</b> (new lead)\n` +
 `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n\n` +
 `💬 <b>Customer said:</b>\n${text}\n\n` +
 `${sendStatus} LEAD-INIT-A:\n${draftReply}\n\n` +
 `Waiting for customer to reply with their address, postal code and phone number.`;
 } else if (parsedInfo) {
 operatorMsg =
 `📥 <b>${inboxId}${followUpTag}</b>\n` +
 `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n\n` +
 `📋 <b>Customer sent contact details:</b>\n` +
 `Address: ${parsedInfo.address}\n` +
 `Postal Code: ${parsedInfo.postalCode}\n` +
 `Phone: ${parsedInfo.phone}\n\n` +
 `<code>/info ${inboxId} ${parsedInfo.address} | ${parsedInfo.postalCode} | ${parsedInfo.phone}</code>\n — ✅ save these details\n` +
 `<code>/info ${inboxId} &lt;address&gt; | &lt;postal&gt; | &lt;phone&gt;</code>\n — ✏️ correct and save`;
 } else {
 operatorMsg =
 `📥 <b>${inboxId}${followUpTag}</b>\n` +
 `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n\n` +
 `💬 <b>Customer said:</b>\n${text}\n\n` +
 `⏸ Nothing auto-sent. Customer is waiting on you.\n\n` +
 `📝 <b>Draft reply:</b>\n${inboxDraft}\n\n` +
 `<code>${inboxId}</code> — ✅ send draft\n` +
 `<code>${inboxId} your message</code> — ✏️ send custom reply`;
 }

 await sendTelegram(OPERATOR_TELEGRAM_ID, operatorMsg);
 console.log(`[crm] Notified operator about ${inboxId} (autoSent=${autoSent}, followUp=${isFollowUp})`);
 return { success: true, contactId: contact.Contact_ID, draftReply, inboxId, autoSent };
}

// ─── handleInfoCommand ────────────────────────────────────────────────────────

export async function handleInfoCommand(args) {
 const { inboxId: requestedId, address, postalCode, phone, namedFields } = args;

 let contact = null;
 let inboxId = null;
 let pending = null;

 const isContactId = /^KA-\d{3,4}$/i.test(requestedId || '');

 if (isContactId) {
 const contacts = await getContacts();
 contact = contacts.find(c => c.Contact_ID === requestedId.toUpperCase());
 if (!contact) return { success: false, message: `⚠️ Contact ${requestedId} not found in sheet.` };
 } else {
 inboxId = normalizeInboxId(requestedId);
 if (!inboxId) return { success: false, message: '⚠️ Invalid ID. Use INBOX-001 or KA-0001.' };
 pending = pendingApprovals.get(inboxId);
 if (!pending) {
 const inboxRow = await findInboxById(inboxId);
 if (!inboxRow) return { success: false, message: `⚠️ No inbox found for ${inboxId}.` };
 const contacts = await getContacts();
 contact = contacts.find(c => c.Contact_ID === inboxRow.row.Contact_ID);
 if (!contact) return { success: false, message: `⚠️ Contact not found for ${inboxId}.` };
 pending = {
 inboxId, rowNum: inboxRow.rowNum, contact,
 contactChannelId: contact.Channel_Contact_ID,
 draftReply: '', customerMessage: inboxRow.row.Customer_Message || '',
 timestamp: new Date().toISOString(),
 };
 pendingApprovals.set(inboxId, pending);
 } else {
 contact = pending.contact;
 }
 }

 const ALLOWED_FIELDS = {
 'Full_Name': 'Full_Name', 'Name': 'Full_Name',
 'Address': 'Address', 'Postal_Code': 'Postal_Code', 'Postal': 'Postal_Code',
 'Phone': 'Phone', 'Phone_Number': 'Phone',
 'Email': 'Email', 'Type': 'Type', 'Notes': 'Notes',
 };

 let updateFields = {};
 let summary = [];

 if (namedFields && Object.keys(namedFields).length > 0) {
 for (const [key, val] of Object.entries(namedFields)) {
 const colName = ALLOWED_FIELDS[key];
 if (!colName) continue;
 updateFields[colName] = val.trim();
 summary.push(`${colName}: ${val.trim()}`);
 }
 } else if (address || postalCode || phone) {
 if (address) { updateFields.Address = address; summary.push(`Address: ${address}`); }
 if (postalCode) { updateFields.Postal_Code = postalCode; summary.push(`Postal: ${postalCode}`); }
 if (phone) { updateFields.Phone = phone; summary.push(`Phone: ${phone}`); }
 if (postalCode) {
 try {
 const area = await getAreaFromPostal(postalCode);
 if (area) { updateFields.Address_Area = area; summary.push(`Area: ${area}`); }
 } catch (e) { /* non-fatal */ }
 }
 } else {
 return { success: false, message: '⚠️ No fields to update. Use named fields or positional format.' };
 }

 if (Object.keys(updateFields).length === 0) {
 return { success: false, message: '⚠️ No recognised fields to update.' };
 }

 updateFields.Last_Updated = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

 try {
 await updateContact(contact.Contact_ID, updateFields);
 if (pending) {
 Object.assign(pending.contact, updateFields);
 pendingApprovals.set(inboxId, pending);
 }
 } catch (e) {
 return { success: false, message: `⚠️ Failed to update contact: ${e.message}` };
 }

 if (pending?.calEventId) {
 try {
 const updatedContact = { ...contact, ...updateFields };
 let zoneId = '';
 try {
 const zone = await getZoneFromPostal(updatedContact.Postal_Code || '');
 zoneId = zone?.Zone_ID || '';
 } catch (e) { /* ignore */ }
 const svcLabel = pending.serviceType ? serviceTypeLabel(pending.serviceType) : '';
 const newTitle = pending.serviceType
 ? `${updatedContact.Contact_ID} — ${updatedContact.Full_Name} — ${svcLabel} ×${pending.units || ''} [${inboxId}]`
 : `${updatedContact.Contact_ID} — ${updatedContact.Full_Name} [${inboxId}]`;
 const newDesc = calBuildDescription({
 contact_id: updatedContact.Contact_ID,
 inbox_id: inboxId,
 service: pending.serviceType || '',
 units: String(pending.units || ''),
 address: updatedContact.Address || '',
 postal: updatedContact.Postal_Code || '',
 phone: updatedContact.Phone || updatedContact.Channel_Contact_ID || '',
 zone: zoneId,
 });
 await calUpdateEvent(pending.calEventId, { summary: newTitle, description: newDesc }, pending.calCalendarId);
 } catch (e) {
 console.warn('[crm] handleInfoCommand: could not update calendar event:', e.message);
 }
 }

 const label = inboxId || contact.Contact_ID;
 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `✅ <b>${label} — contact updated</b>\n` +
 `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n` +
 summary.join('\n') +
 (inboxId && !isContactId
 ? `\n\nNow run: <code>/b ${inboxId} GC 3</code> to generate booking slots.`
 : '')
 );

 return { success: true, inboxId: inboxId || contact.Contact_ID, contactId: contact.Contact_ID, updated: updateFields };
}

// ─── handleOperatorApproval ───────────────────────────────────────────────────

export async function handleOperatorApproval(operatorMsg, { notifyFn } = {}) {
 const replyToOperator = notifyFn ?? ((text) => sendTelegram(OPERATOR_TELEGRAM_ID, text));
 const { text } = operatorMsg;
 const trimmed = text.trim();

 const inboxMatch = trimmed.match(/^(?:INBOX|IN)-(\d+)(?:\s+([\s\S]+))?$/i);
 let inboxId = null;
 let customText = null;

 if (inboxMatch) {
 const num = parseInt(inboxMatch[1], 10);
 inboxId = `INBOX-${String(num).padStart(3, '0')}`;
 customText = inboxMatch[2]?.trim() || null;

 if (!pendingApprovals.has(inboxId)) {
 const inboxRow = await findInboxById(inboxId);
 if (!inboxRow) {
 await replyToOperator(`⚠️ No inbox found for ${inboxId}.`);
 return { success: false, reason: 'not_found' };
 }
 if (!customText) {
 await replyToOperator(`⚠️ No draft queued for ${inboxId}. To send a message: ${inboxId} your message here`);
 return { success: false, reason: 'no_draft' };
 }
 const contactId = inboxRow.row.Contact_ID;
 const contacts = await getContacts();
 const contact = contacts.find(c => c.Contact_ID === contactId);
 if (!contact) {
 await replyToOperator(`⚠️ Inbox ${inboxId} references unknown contact ${contactId}.`);
 return { success: false, reason: 'contact_missing' };
 }
 pendingApprovals.set(inboxId, {
 inboxId, rowNum: inboxRow.rowNum, contact,
 contactChannelId: contact.Channel_Contact_ID,
 draftReply: customText,
 customerMessage: inboxRow.row.Customer_Message || '(rehydrated)',
 timestamp: new Date().toISOString(),
 });
 }
 } else if (pendingApprovals.size === 1) {
 const lowerCmd = trimmed.toLowerCase();
 if (['approve', 'send', 'ok', 'yes', 'y'].includes(lowerCmd)) {
 inboxId = pendingApprovals.keys().next().value;
 }
 }

 if (!inboxId) {
 if (pendingApprovals.size === 0) {
 await replyToOperator('⚠️ No pending customer messages.');
 } else {
 const list = [...pendingApprovals.values()]
 .map(p => `• ${p.inboxId} - ${p.contact.Full_Name}: "${p.customerMessage.slice(0, 60)}"`)
 .join('\n');
 await replyToOperator(`📋 <b>Pending inbox:</b>\n${list}\n\nReply <b>INBOX-NNN</b> to send draft, or <b>INBOX-NNN your message</b> to override.`);
 }
 return { success: false, reason: 'no_match' };
 }

 const pending = pendingApprovals.get(inboxId);
 const targetContactId = pending.contactChannelId;
 const replyText = customText ?? pending.draftReply;
 const isApprove = !customText;
 const shouldKeepOpen = !pending.finalizationContext;

 if (!shouldKeepOpen) pendingApprovals.delete(inboxId);

 let createdJobId = null;

 // ── Manual calendar booking path ──────────────────────────────────────────
 if (pending.isManualCalEvent) {
 const contact = pending.contact;
 const channelId = pending.contactChannelId;
 const hasChannel = channelId && String(channelId).trim() !== '';
 const msgToSend = customText || pending.draftReply || '';

 if (!msgToSend || msgToSend === '(complete missing fields first)') {
 await replyToOperator(`⚠️ ${inboxId} — cannot confirm yet. Missing info. Run /calinfo and /info first.`);
 return { success: false, reason: 'missing_info', inboxId };
 }

 let manualCalTeamId = '';
 try {
 const allTeams = await getTeamCalendars();
 const matchedTeam = allTeams.find(t => t.Calendar_ID && t.Calendar_ID === pending.calCalendarId);
 if (matchedTeam?.Team_ID) manualCalTeamId = matchedTeam.Team_ID;
 } catch (err) {
 console.warn('[crm] handleOperatorApproval: Assigned_Team lookup failed (non-fatal):', err.message);
 }

 let jobId = null;
 try {
 const jobResult = await createJob({
 Contact_ID: contact.Contact_ID,
 Customer_Name: contact.Full_Name,
 Job_Date: pending.calDate || new Date().toISOString().split('T')[0],
 Service_Type: pending.serviceType || '',
 Units_In_Home: String(pending.units || ''),
 Units_Serviced: String(pending.units || ''),
 Amount_SGD: '',
 Payment_Status: 'Pending',
 Status: 'Scheduled',
 Booking_Source: 'Manual Calendar',
 Notes: `Manual booking. Time: ${pending.calStartHHMM || ''}–${pending.calEndHHMM || ''}`,
 Team_ID: manualCalTeamId,
 });
 jobId = jobResult?.Job_ID || null;
 } catch (err) {
 console.error('[crm] handleOperatorApproval: manual cal createJob error:', err.message);
 await replyToOperator(`❌ Error creating job for ${inboxId}: ${err.message}`);
 return { success: false, reason: 'job_creation_failed', inboxId };
 }

 const manualCalUpdateFields = { Contact_Status: 'Customer', Last_Updated: new Date().toISOString() };
 if (!contact.Assigned_Team || contact.Assigned_Team.trim() === '') {
 if (manualCalTeamId) manualCalUpdateFields.Assigned_Team = manualCalTeamId;
 }
 try {
 await updateContact(contact.Contact_ID, manualCalUpdateFields);
 } catch (err) {
 console.warn('[crm] handleOperatorApproval: updateContact error:', err.message);
 }

 if (pending.calEventId && jobId) {
 try {
 const updatedDesc = calBuildDescription({
 contact_id: contact.Contact_ID,
 job_id: jobId,
 service: pending.serviceType || '',
 units: String(pending.units || ''),
 address: contact.Address || '',
 postal: contact.Postal_Code || '',
 phone: contact.Phone || contact.Channel_Contact_ID || '',
 });
 await calUpdateEvent(pending.calEventId, { description: updatedDesc }, pending.calCalendarId);
 } catch (e) {
 console.warn('[crm] handleOperatorApproval: calendar update error:', e.message);
 }
 }

 if (hasChannel) {
 const calCustomerChannel = (contact.Source || '').includes('WhatsApp') ? 'WhatsApp' : 'Telegram';
 try {
 if (calCustomerChannel === 'WhatsApp') {
 await sendWhatsApp(channelId, msgToSend);
 } else {
 await sendTelegram(channelId, msgToSend);
 }
 await replyToOperator(`✅ ${inboxId} confirmed. Job: ${jobId}. Confirmation sent to ${contact.Full_Name}.`);
 } catch (err) {
 console.warn('[crm] handleOperatorApproval: send to customer failed:', err.message);
 await replyToOperator(`✅ Job created: ${jobId}\n⚠️ Could not send message to customer. Contact directly: ${contact.Phone || 'check sheet'}`);
 }
 } else {
 await replyToOperator(
 `✅ Job created: ${jobId}\nCustomer: ${contact.Full_Name} (${contact.Contact_ID})\n\n` +
 `⚠️ No channel ID on file. Contact directly:\n📞 ${contact.Phone || 'check sheet'}\n\nMessage to send:\n———\n${msgToSend}\n———`
 );
 }

 pendingApprovals.delete(inboxId);
 return { success: true, inboxId, jobId, reason: 'manual_cal_confirmed' };
 }

 // ── Standard booking finalization path ────────────────────────────────────
 if (pending.finalizationContext) {
 const fc = pending.finalizationContext;
 try {
 let calendarEventId = fc.calendarEventId || null;
 try {
 if (fc.slot && fc.slot.Date && fc.placedStartHHMM && fc.placedEndHHMM) {
 const startMins = parseHHMM(fc.placedStartHHMM);
 const endMins = parseHHMM(fc.placedEndHHMM);
 if (startMins !== null && endMins !== null) {
 const start = sgtDateAtMinutes(fc.slot.Date, startMins);
 const end = sgtDateAtMinutes(fc.slot.Date, endMins);
 const zoneId = (fc.slot.Primary_Zone || '').split('+')[0].trim();
 const title = calBuildTitle({
 contactId: pending.contact.Contact_ID,
 fullName: pending.contact.Full_Name,
 serviceLabel: fc.serviceType,
 units: fc.units,
 tag: `(${createdJobId})`,
 });
 const description = calBuildDescription({
 contact_id: pending.contact.Contact_ID,
 inbox_id: pending.inboxId,
 job_id: createdJobId,
 service: fc.serviceType,
 units: fc.units,
 zone: zoneId,
 phone: fc.phone || '',
 postal: fc.postalCode || '',
 address: fc.address || '',
 price_sgd: fc.price || '',
 });
 if (fc.calendarEventId) {
 await calUpdateEvent(fc.calendarEventId, {
 summary: title, description, status: 'confirmed',
 ...(zoneId && ZONE_COLOR[zoneId] ? { colorId: ZONE_COLOR[zoneId] } : {}),
 }, fc.slot?.Calendar_ID);
 } else {
 const ev = await calCreateEvent({
 title, start, end, description, status: 'confirmed',
 colorId: zoneId ? ZONE_COLOR[zoneId] : undefined,
 calendarId: pending.finalizationContext?.slot?.Calendar_ID || undefined,
 });
 fc.calendarEventId = ev.id;
 calendarEventId = ev.id;
 }
 }
 }
 } catch (e) {
 console.error('[crm] calendar event create failed:', e.message);
 }

 const jobResult = await createJob({
 Contact_ID: pending.contact.Contact_ID,
 Customer_Name: pending.contact.Full_Name,
 Job_Date: fc.slot.Date,
 Service_Type: fc.serviceType,
 Units: fc.units,
 Price_SGD: fc.price,
 Address: fc.address,
 Notes: `Booked via ${(pending.contact.Source || '').includes('WhatsApp') ? 'WhatsApp' : 'Telegram bot'}. Address: ${fc.address}. Phone: ${fc.phone}.`,
 Calendar_Event_ID: calendarEventId || '',
 Team_ID: fc.slot?.Team_ID || '',
 });
 createdJobId = jobResult?.Job_ID;

 if (calendarEventId && createdJobId) {
 try {
 const zoneId = (fc.slot.Primary_Zone || '').split('+')[0].trim();
 const description = calBuildDescription({
 contact_id: pending.contact.Contact_ID,
 inbox_id: pending.inboxId,
 job_id: createdJobId,
 service: fc.serviceType,
 units: fc.units,
 zone: zoneId,
 phone: fc.phone || '',
 postal: fc.postalCode || '',
 address: fc.address || '',
 price_sgd: fc.price || '',
 });
 const title = calBuildTitle({
 contactId: pending.contact.Contact_ID,
 fullName: pending.contact.Full_Name,
 serviceLabel: fc.serviceType,
 units: fc.units,
 tag: `(${createdJobId})`,
 });
 await calUpdateEvent(calendarEventId, { summary: title, description }, fc.slot?.Calendar_ID);
 } catch (e) {
 console.error('[crm] back-link job_id to event failed:', e.message);
 }
 }

 const confirmSlotUpdateFields = {
 Contact_Status: 'Customer',
 Last_Updated: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }),
 };
 if ((!pending.contact.Assigned_Team || pending.contact.Assigned_Team.trim() === '') && fc.slot?.Team_ID) {
 confirmSlotUpdateFields.Assigned_Team = fc.slot.Team_ID;
 }
 try {
 await updateContact(pending.contact.Contact_ID, confirmSlotUpdateFields);
 } catch (e) { console.error('[crm] updateContact status failed:', e.message); }

 } catch (e) {
 console.error('[crm] createJob failed:', e.message);
 await replyToOperator(`⚠️ Job creation failed: ${e.message}. Confirmation still sent.`);
 }
 }

 if (pending.rowNum && !shouldKeepOpen) {
 try { await resolveInbox(pending.rowNum, replyText); }
 catch (e) { console.error('[crm] resolveInbox failed:', e.message); }
 }

 const isTestCustomer = String(targetContactId).startsWith('TEST-');
 const customerChannel = (pending.contact.Source || '').includes('WhatsApp') ? 'WhatsApp' : 'Telegram';
 if (!isTestCustomer) {
 if (customerChannel === 'WhatsApp') {
 await sendWhatsApp(targetContactId, replyText);
 } else {
 await sendTelegram(targetContactId, replyText);
 }
 }

 await logMessage({
 Contact_ID: pending.contact.Contact_ID,
 Direction: 'Outbound',
 Channel: customerChannel,
 Message_Text: replyText,
 Sent_By: isApprove ? 'Bot (Operator Approved)' : 'Operator',
 Status: 'Sent',
 });

 if (shouldKeepOpen) pending.draftReply = replyText;

 const testTag = isTestCustomer ? ' [TEST - not sent to customer]' : '';
 const jobLine = createdJobId ? `\n\n💼 Job created: <b>${createdJobId}</b>` : '';
 const stayOpenLine = shouldKeepOpen
 ? `\n\n🔗 Inbox <code>${pending.inboxId}</code> still open.\nNext: <code>/b ${pending.inboxId} GC 3</code> for slots, or <code>${pending.inboxId} ...</code> to keep chatting.`
 : `\n\n✅ Inbox closed.`;

 await replyToOperator(`✅ ${pending.inboxId} sent to ${pending.contact.Full_Name} (${pending.contact.Contact_ID})${testTag}:\n\n${replyText}${jobLine}${stayOpenLine}`);
 console.log(`[crm] Sent ${pending.inboxId} to ${targetContactId}`);
 return { success: true, inboxId: pending.inboxId, sentTo: targetContactId, message: replyText };
}

// ─── isQueueApprovalText ──────────────────────────────────────────────────────

export function isQueueApprovalText(text) {
 if (!text) return null;
 const m = text.trim().match(/^Q-(\d{3})$/i);
 return m ? m[1].padStart(3, '0') : null;
}

// ─── handleQueueApproval ──────────────────────────────────────────────────────

export async function handleQueueApproval(seqNum, notifyFn) {
 const queue = await getQueue();
 const entry = queue.find(q => (q.Queue_ID || '').endsWith('-' + seqNum));

 if (!entry) {
 await notifyFn(`⚠️ No queued draft found for Q-${seqNum}.`);
 return;
 }

 try {
 if ((entry.Channel || '').toLowerCase() === 'whatsapp') {
 await sendWhatsApp(entry.Contact_ID, entry.Draft_Text);
 } else {
 await sendTelegram(entry.Contact_ID, entry.Draft_Text);
 }
 } catch (err) {
 await notifyFn(`❌ Failed to send Q-${seqNum} to ${entry.Contact_ID} via ${entry.Channel}: ${err.message}`);
 return;
 }

 await logMessage({
 Contact_ID: entry.Contact_ID,
 Direction: 'Outbound',
 Channel: entry.Channel || 'Telegram',
 Message_Text: entry.Draft_Text,
 Sent_By: 'Bot (Module3 Approved)',
 Status: 'Sent',
 });

 const found = await findQueueById(entry.Queue_ID);
 if (found) await removeFromQueue(found.id);

 await notifyFn(`✅ Sent Q-${seqNum} to ${entry.Contact_ID} via ${entry.Channel || 'Telegram'}.`);
}
