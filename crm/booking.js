/**
 * booking.js — Booking and scheduling handlers for KoolAircon CRM
 *
 * Exports:
 * handleBookingCommand — /b command: find available slots
 * handleConfirmSlot — /confirm command: lock in a slot
 * handleConfirmBooking — /confirmb command: confirm from calendar event
 * handleMixYes — /mixyes command: search all teams
 * handleMixNo — /mixno command: search home team only
 * handleCheckCal — /checkCal command: scan calendar for manual events
 * handleCalInfo — /calinfo command: set service/units on manual booking
 */

import {
 findInboxById,
 resolveInbox,
 createJob,
 updateJob,
 updateContact,
 addToInbox,
 findOpenInboxForContact,
 getContacts,
 getJobs,
 getTeams,
 getPriceFromTable,
 getTemplate,
 fillTemplate,
 getSettings,
} from './sheets.js';

import {
 getZoneFromPostal,
 getDurationMins,
 findAvailableSlots,
 formatSlotOptions,
 placeWindowInBlock,
 format12h,
 formatHHMM,
 parseHHMM,
 serviceTypeLabel,
 getTeamCalendars,
} from './scheduler.js';

import {
 createEvent as calCreateEvent,
 updateEvent as calUpdateEvent,
 findEventsByInbox,
 parseDescription as calParseDescription,
 buildDescription as calBuildDescription,
 buildTitle as calBuildTitle,
 extractFromTitle as calExtractFromTitle,
 listEvents,
 ZONE_COLOR,
} from './calendar.js';

import {
 sendTelegram,
 OPERATOR_TELEGRAM_ID,
 pendingApprovals,
 BLOCK_SIZE_MINS,
} from './bot.js';

import { sendWhatsApp } from './whatsapp.js';
import * as db from './db.js';
import { broadcastToUI } from './broadcast.js';

// ─── Local helpers ────────────────────────────────────────────────────────────

function customerChannelFor(contact) {
 return (contact?.Source || '').includes('WhatsApp') ? 'whatsapp' : 'telegram';
}

// Wraps a notifyFn (or the default operator Telegram send) so every operator
// notification also reaches the browser UI (broadcastToUI) and gets logged to
// SQLite as a bot-resp row, without repeating that logic at every call site.
function makeNotify(notifyFn, contact, inboxId) {
 const send = notifyFn ?? ((text) => sendTelegram(OPERATOR_TELEGRAM_ID, text));
 return async (text) => {
 await send(text);
 broadcastToUI({ type: 'bot-resp', inboxId, contactId: contact?.Contact_ID, channel: customerChannelFor(contact), text, timestamp: Date.now() });
 if (contact?.Channel_Contact_ID) {
 await db.insert({
 conversation_id: String(contact.Channel_Contact_ID),
 channel: customerChannelFor(contact),
 direction: 'outbound',
 message_type: 'bot-resp',
 text,
 sender: 'operator',
 }).catch(e => console.error('[booking] db log failed:', e.message));
 }
 };
}

export function normalizeInboxId(raw) {
 if (!raw) return null;
 const num = parseInt(raw.replace(/^(?:INBOX|IN)-/i, ''), 10);
 if (isNaN(num)) return null;
 return `INBOX-${String(num).padStart(3, '0')}`;
}

function sgtDateAtMinutes(dateStr, mins) {
 const hh = String(Math.floor(mins / 60)).padStart(2, '0');
 const mm = String(mins % 60).padStart(2, '0');
 return new Date(`${dateStr}T${hh}:${mm}:00+08:00`);
}

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

function roundUpToBlock(mins) {
 return Math.ceil(mins / BLOCK_SIZE_MINS) * BLOCK_SIZE_MINS;
}

async function getTravelTimeMins(originAddress, destinationAddress) {
 const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
 if (!GOOGLE_MAPS_API_KEY || !originAddress || !destinationAddress) return null;
 try {
 const origin = encodeURIComponent(originAddress + ', Singapore');
 const destination = encodeURIComponent(destinationAddress + ', Singapore');
 const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destination}&mode=driving&key=${GOOGLE_MAPS_API_KEY}`;
 const res = await fetch(url);
 const data = await res.json();
 if (data.status === 'OK' && data.rows?.[0]?.elements?.[0]?.status === 'OK') {
 const secs = data.rows[0].elements[0].duration.value;
 return Math.ceil(secs / 60);
 }
 } catch (e) {
 console.error('[booking] Maps API error:', e.message);
 }
 return null;
}

async function calculateBlockMins(serviceMins, previousJobAddress, thisJobAddress) {
 if (!previousJobAddress) return roundUpToBlock(serviceMins);
 const travelMins = await getTravelTimeMins(previousJobAddress, thisJobAddress);
 if (travelMins === null) return roundUpToBlock(serviceMins + 30);
 const travelBufferMins = parseInt((await getSettings()).Travel_Buffer_Mins ?? '15', 10);
 const totalMins = serviceMins + travelMins + travelBufferMins;
 return roundUpToBlock(totalMins);
}

async function getPreviousJobAddress(slotDate) {
 try {
 const jobs = await getJobs();
 const dayJobs = jobs.filter(j =>
 j.Job_Date === slotDate &&
 ['Scheduled', 'Completed'].includes(j.Status) &&
 j.Address
 );
 if (dayJobs.length === 0) return null;
 return dayJobs[dayJobs.length - 1].Address || null;
 } catch (e) {
 console.error('[booking] getPreviousJobAddress error:', e.message);
 return null;
 }
}

function fmtCheckCalDate(d) {
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtCheckCalHHMM(d) {
 const sgt = new Date(d.getTime() + 8 * 60 * 60 * 1000);
 return `${String(sgt.getUTCHours()).padStart(2,'0')}:${String(sgt.getUTCMinutes()).padStart(2,'0')}`;
}

function fmtCheckCal12h(hhmm) {
 const [h, m] = hhmm.split(':').map(Number);
 const period = h >= 12 ? 'pm' : 'am';
 const h12 = h % 12 || 12;
 return `${h12}${m === 0 ? '' : `:${String(m).padStart(2,'0')}`}${period}`;
}

// ─── _presentSlots ────────────────────────────────────────────────────────────

async function _presentSlots({ inboxId, pending, candidateSlots, serviceType, units, serviceMins, postalCode, zoneId, replyToOperator }) {
 const slotsWithBuffer = [];
 for (const slot of candidateSlots) {
 const previousAddr = await getPreviousJobAddress(slot.Date);
 const mapsBlockMins = await calculateBlockMins(serviceMins, previousAddr, pending.contact.Address || postalCode);
 const zoneBufferBlockMins = serviceMins + (slot.travelBufferMins || 0);
 const blockMins = Math.max(mapsBlockMins, zoneBufferBlockMins);
 const minsRemaining = parseInt(slot.Mins_Remaining || '0', 10);
 if (minsRemaining >= blockMins) {
 const placed = placeWindowInBlock(slot, serviceMins, blockMins);
 if (placed.ok) {
 slotsWithBuffer.push({
 ...slot,
 blockMins,
 previousAddr,
 placedStartMins: placed.placedStartMins,
 placedEndMins: placed.placedEndMins,
 placedReservedEndMins: placed.placedReservedEndMins,
 });
 }
 }
 if (slotsWithBuffer.length >= 3) break;
 }

 if (slotsWithBuffer.length === 0) {
 await replyToOperator(`⚠️ ${inboxId} — No slots with sufficient capacity found. Service: ${serviceType} ×${units} = ${serviceMins} mins + travel buffer. Check schedule manually.`);
 return { success: false, reason: 'no_slots_with_buffer', message: 'No slots with sufficient capacity after travel buffer.' };
 }

 const price = await getPriceFromTable(serviceType.toUpperCase(), units);
 const priceLine = price > 0 ? `\nEstimated price: $${price} SGD\n` : '';
 const formattedOptions = formatSlotOptions(slotsWithBuffer);
 const draftText = `Great news! Based on your location${priceLine}\n` + formattedOptions;

 const bookingContext = { postalCode, serviceType: serviceType.toUpperCase(), units, slots: slotsWithBuffer, price };
 pending.draftReply = draftText;
 pending.bookingContext = bookingContext;
 pendingApprovals.set(inboxId, pending);

 const operatorMsg =
 `📅 <b>${inboxId} — booking draft ready</b>\n` +
 `Contact: ${pending.contact.Full_Name} (${pending.contact.Contact_ID})\n` +
 `Address: ${pending.contact.Address || 'not saved'}\n` +
 `Service: ${serviceType.toUpperCase()} ×${units} (${serviceMins} mins)\n` +
 `Zone: ${zoneId}\n\n` +
 `📝 <b>Draft slot offer (${slotsWithBuffer.length} options):</b>\n${draftText}\n\n` +
 `<code>${inboxId}</code> — ✅ send these slots to customer\n` +
 `<code>${inboxId} your custom text</code> — ✏️ override`;

 await replyToOperator(operatorMsg);
 return { success: true, inboxId, draft: draftText, slots: slotsWithBuffer };
}

// ─── handleBookingCommand (/b) ────────────────────────────────────────────────

export async function handleBookingCommand(args, { notifyFn } = {}) {
 const { inboxId: requestedInboxId, serviceType, units, contactId: requestedContactId } = args;

 if (requestedContactId) {
 const contacts = await getContacts();
 const contact = contacts.find(c => c.Contact_ID === requestedContactId);
 if (!contact) {
 return { success: false, reason: 'contact_not_found', message: `No contact found: ${requestedContactId}.` };
 }
 const placeholderMsg = '(operator-initiated booking)';
 const contactChannel = (contact.Source || '').includes('WhatsApp') ? 'WhatsApp' : 'Telegram';
 const newInboxId = await addToInbox({
 Contact_ID: contact.Contact_ID,
 Contact_Name: contact.Full_Name,
 Customer_Message: placeholderMsg,
 Draft_Reply: '(awaiting /b draft)',
 Channel: contactChannel,
 Status: 'Pending',
 });
 const found = await findOpenInboxForContact(contact.Contact_ID);
 pendingApprovals.set(newInboxId, {
 inboxId: newInboxId,
 rowNum: found?.rowNum,
 contact,
 contactChannelId: contact.Channel_Contact_ID,
 draftReply: '(awaiting /b draft)',
 customerMessage: placeholderMsg,
 timestamp: new Date().toISOString(),
 });
 return handleBookingCommand({ inboxId: newInboxId, serviceType, units }, { notifyFn });
 }

 const inboxId = normalizeInboxId(requestedInboxId);
 if (!inboxId) {
 return { success: false, reason: 'no_inbox', message: '⚠️ Inbox ID is required. Usage: /b INBOX-001 GC 3' };
 }

 let pending = pendingApprovals.get(inboxId);
 if (!pending) {
 const inboxRow = await findInboxById(inboxId);
 if (!inboxRow) return { success: false, reason: 'not_found', message: `No inbox found for ${inboxId}.` };
 const contacts = await getContacts();
 const contact = contacts.find(c => c.Contact_ID === inboxRow.row.Contact_ID);
 if (!contact) return { success: false, reason: 'contact_missing', message: `Contact not found for ${inboxId}.` };
 pending = {
 inboxId, rowNum: inboxRow.rowNum, contact,
 contactChannelId: contact.Channel_Contact_ID,
 draftReply: '', customerMessage: inboxRow.row.Customer_Message || '',
 timestamp: new Date().toISOString(),
 };
 pendingApprovals.set(inboxId, pending);
 }

 const freshContacts = await getContacts();
 const freshContact = freshContacts.find(c => c.Contact_ID === pending.contact.Contact_ID);
 if (freshContact) Object.assign(pending.contact, freshContact);

 const notify = makeNotify(notifyFn, pending.contact, inboxId);

 const postalCode = pending.contact.Postal_Code;
 if (!postalCode || postalCode.length < 6) {
 await notify(
 `⚠️ <b>${inboxId}</b> — No postal code saved for ${pending.contact.Full_Name}.\n\n` +
 `Run: <code>/info ${inboxId} &lt;address&gt; | &lt;postal&gt; | &lt;phone&gt;</code> first.`
 );
 return { success: false, reason: 'no_postal', message: 'No postal code on file. Run /info first.' };
 }

 const zone = await getZoneFromPostal(postalCode);
 if (!zone) return { success: false, reason: 'no_zone', message: `Could not find zone for postal code ${postalCode}.` };

 const serviceMins = await getDurationMins(serviceType, units);
 const allTeams = await getTeams();
 const activeTeams = allTeams.filter(t => t.Active?.toUpperCase() === 'TRUE' && t.Calendar_ID?.trim());

 if (activeTeams.length === 0) {
 await notify(
 `⚠️ <b>No active teams configured — booking held for ${inboxId}</b>\n\n` +
 `Contact: ${pending.contact.Full_Name} (${pending.contact.Contact_ID})\n` +
 `Zone: ${zone.Zone_ID} | Postal: ${postalCode}\n\n` +
 `Please activate at least one team in <b>3D_Teams</b> (set Active = TRUE and ensure Calendar_ID is filled), then re-run the booking command.`
 );
 return { success: false, reason: 'no_active_teams', message: 'No active teams configured. Operator alerted.' };
 }

 const assignedTeamId = pending.contact?.Assigned_Team || '';
 if (assignedTeamId) {
 const teamStillActive = activeTeams.some(t => (t.Team_ID || '').trim() === assignedTeamId.trim());
 if (!teamStillActive) {
 await notify(
 `⚠️ <b>Assigned team inactive — booking held for ${inboxId}</b>\n\n` +
 `Contact: ${pending.contact.Full_Name} (${pending.contact.Contact_ID})\n` +
 `Assigned team: <b>${assignedTeamId}</b> is not in the active team list.\n` +
 `Zone: ${zone.Zone_ID} | Postal: ${postalCode}\n\n` +
 `Please either reactivate ${assignedTeamId} in <b>3D_Teams</b>, or update <b>Assigned_Team</b> on this contact in <b>1_Contacts</b>, then re-run the booking command.`
 );
 return { success: false, reason: 'assigned_team_inactive', message: `Assigned team ${assignedTeamId} is no longer active. Operator alerted.` };
 }
 }

 const candidateSlots = await findAvailableSlots(zone.Zone_ID, serviceMins, 10, pending.contact?.Assigned_Team || '', allTeams);

 if (candidateSlots.length > 0 && candidateSlots[0]._operatorFlag) {
 const flag = candidateSlots[0];
 await notify(
 `⚠️ <b>${inboxId} — Manual scheduling required</b>\n\n` +
 `Contact: ${pending.contact.Full_Name} (${pending.contact.Contact_ID})\n` +
 `Service: ${serviceType} × ${units} units = ${serviceMins} mins\n` +
 `Zone: ${zone.Zone_ID}\n\n` +
 `This job (${serviceMins} mins) doesn't fit in a single block.\n` +
 `If confirmed, create a calendar event manually and run /checkCal to draft the confirmation.`
 );
 return { success: false, reason: 'operator_required', inboxId, message: flag._message };
 }

 if (candidateSlots.length === 0) {
 await notify(`⚠️ <b>${inboxId}</b> — No available slots for ${pending.contact.Full_Name} in zone ${zone.Zone_ID}.`);
 return { success: false, reason: 'no_slots', message: 'No available slots found.' };
 }

 const assignedTeam = pending.contact?.Assigned_Team || '';
 if (assignedTeam && candidateSlots.length > 0 && !candidateSlots[0]._operatorFlag) {
 const todaySGT = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
 const d7 = new Date(`${todaySGT}T00:00:00+08:00`);
 d7.setDate(d7.getDate() + 7);
 const cutoffStr = d7.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
 const firstSlotDate = candidateSlots[0].Date || '';

 if (firstSlotDate > cutoffStr) {
 let mixMsg;
 try {
 const tpl = await getTemplate('MIX-PROMPT-A');
 if (tpl && tpl.Message_Text) mixMsg = fillTemplate(tpl.Message_Text, { Name: pending.contact.Full_Name });
 } catch (e) { /* use fallback */ }
 if (!mixMsg) {
 mixMsg =
 `Hi ${pending.contact.Full_Name}! 😊 Your usual team's next available slot is on ${firstSlotDate}.\n\n` +
 `We may be able to get you in sooner with one of our other teams. Would you be open to that?`;
 }

 pending.mixContext = {
 zoneId: zone.Zone_ID, serviceMins,
 serviceType: serviceType.toUpperCase(), units, postalCode,
 assignedTeam, count: 10,
 };
 pending.draftReply = mixMsg;
 pending.bookingContext = null;
 pendingApprovals.set(inboxId, pending);

 await notify(
 `📅 <b>${inboxId} — repeat customer, soonest home-team slot is ${firstSlotDate}</b>\n` +
 `Contact: ${pending.contact.Full_Name} (${pending.contact.Contact_ID})\n` +
 `Home team: ${assignedTeam} | Zone: ${zone.Zone_ID}\n\n` +
 `Their team's next slot is more than 7 days out.\n\n` +
 `📝 <b>Draft message for customer (MIX-PROMPT-A):</b>\n${mixMsg}\n\n` +
 `<code>${inboxId}</code> — ✅ send this to customer\n` +
 `<code>${inboxId} your custom text</code> — ✏️ override\n\n` +
 `After customer replies:\n` +
 `<code>/mixyes ${inboxId}</code> — open to another team (search all teams)\n` +
 `<code>/mixno ${inboxId}</code> — wants home team only (show home slots regardless)`
 );
 return { success: true, inboxId, action: 'mix_prompt_sent', firstSlotDate };
 }
 }

 return _presentSlots({ inboxId, pending, candidateSlots, serviceType, units, serviceMins, postalCode, zoneId: zone.Zone_ID, replyToOperator: notify });
}

// ─── handleMixNo (/mixno) ─────────────────────────────────────────────────────

export async function handleMixNo(inboxId) {
 const pending = pendingApprovals.get(inboxId);
 if (!pending) return { success: false, reason: 'not_found', message: `No pending booking for ${inboxId}.` };
 const mx = pending.mixContext;
 if (!mx) return { success: false, reason: 'no_mix_context', message: `No mix context on ${inboxId} — run /b first.` };

 const candidateSlots = await findAvailableSlots(mx.zoneId, mx.serviceMins, mx.count, mx.assignedTeam);
 if (candidateSlots.length > 0 && candidateSlots[0]._operatorFlag) {
 await sendTelegram(OPERATOR_TELEGRAM_ID, `⚠️ <b>${inboxId} /mixno — manual scheduling required</b>\n${candidateSlots[0]._message}`);
 return { success: false, reason: 'operator_required', message: candidateSlots[0]._message };
 }
 if (candidateSlots.length === 0) {
 await sendTelegram(OPERATOR_TELEGRAM_ID, `⚠️ <b>${inboxId} /mixno</b> — No home-team slots found in zone ${mx.zoneId}.`);
 return { success: false, reason: 'no_slots', message: 'No home-team slots found.' };
 }

 const replyToOperator = (text) => sendTelegram(OPERATOR_TELEGRAM_ID, text);
 return _presentSlots({ inboxId, pending, candidateSlots, serviceType: mx.serviceType, units: mx.units, serviceMins: mx.serviceMins, postalCode: mx.postalCode, zoneId: mx.zoneId, replyToOperator });
}

// ─── handleMixYes (/mixyes) ───────────────────────────────────────────────────

export async function handleMixYes(inboxId) {
 const pending = pendingApprovals.get(inboxId);
 if (!pending) return { success: false, reason: 'not_found', message: `No pending booking for ${inboxId}.` };
 const mx = pending.mixContext;
 if (!mx) return { success: false, reason: 'no_mix_context', message: `No mix context on ${inboxId} — run /b first.` };

 const candidateSlots = await findAvailableSlots(mx.zoneId, mx.serviceMins, mx.count, '');
 if (candidateSlots.length > 0 && candidateSlots[0]._operatorFlag) {
 await sendTelegram(OPERATOR_TELEGRAM_ID, `⚠️ <b>${inboxId} /mixyes — manual scheduling required</b>\n${candidateSlots[0]._message}`);
 return { success: false, reason: 'operator_required', message: candidateSlots[0]._message };
 }
 if (candidateSlots.length === 0) {
 await sendTelegram(OPERATOR_TELEGRAM_ID, `⚠️ <b>${inboxId} /mixyes</b> — No slots found across any team in zone ${mx.zoneId}.`);
 return { success: false, reason: 'no_slots', message: 'No slots found across all teams.' };
 }

 const replyToOperator = (text) => sendTelegram(OPERATOR_TELEGRAM_ID, text);
 return _presentSlots({ inboxId, pending, candidateSlots, serviceType: mx.serviceType, units: mx.units, serviceMins: mx.serviceMins, postalCode: mx.postalCode, zoneId: mx.zoneId, replyToOperator });
}

// ─── handleConfirmSlot (/confirm) ────────────────────────────────────────────

export async function handleConfirmSlot(args, { notifyFn } = {}) {
 const { inboxId: requestedInboxId, choice, placement } = args;
 const inboxId = normalizeInboxId(requestedInboxId);
 if (!inboxId) return { success: false, message: '⚠️ Inbox ID required. Usage: /confirm INBOX-001 2 [@ HH:MM]' };

 let pending = pendingApprovals.get(inboxId);

 if (!pending || !pending.bookingContext) {
 const inboxRow = await findInboxById(inboxId);
 if (!inboxRow) return { success: false, message: `⚠️ No inbox found for ${inboxId}.` };
 const contacts = await getContacts();
 const contact = contacts.find(c => c.Contact_ID === inboxRow.row.Contact_ID);
 if (!contact) return { success: false, message: `⚠️ Contact not found for ${inboxId}.` };

 let bookingContext = null;
 try {
 const notes = inboxRow.row.Notes || '';
 const ctxMatch = notes.match(/BOOKING_CTX:(\{.+\})/);
 if (ctxMatch) bookingContext = JSON.parse(ctxMatch[1]);
 } catch (e) { /* could not parse */ }

 if (!bookingContext) {
 await makeNotify(notifyFn, contact, inboxId)(
 `⚠️ <b>${inboxId} — booking context lost (plugin restart)</b>\n` +
 `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n\n` +
 `Please re-run to regenerate slots:\n` +
 `<code>/b ${inboxId} GC 3</code> (adjust service/units as needed)\n` +
 `Then run /confirm again once customer confirms their choice.`
 );
 return { success: false, message: `Booking context for ${inboxId} was lost. Re-run /b ${inboxId} <service> <units> to regenerate slots.` };
 }

 pending = {
 inboxId, rowNum: inboxRow.rowNum, contact,
 contactChannelId: contact.Channel_Contact_ID,
 draftReply: '', customerMessage: inboxRow.row.Customer_Message || '',
 timestamp: new Date().toISOString(), bookingContext,
 };
 pendingApprovals.set(inboxId, pending);
 }

 const booking = pending.bookingContext;
 if (!booking || !booking.slots || booking.slots.length === 0) {
 return { success: false, message: `⚠️ No slot offer found for ${inboxId}. Run /b ${inboxId} <service> <units> first.` };
 }

 const optionIdx = parseInt(String(choice).trim(), 10);
 if (isNaN(optionIdx) || optionIdx < 1 || optionIdx > booking.slots.length) {
 return { success: false, message: `❌ Choice must be 1–${booking.slots.length}. Got: ${choice}` };
 }

 const slot = booking.slots[optionIdx - 1];
 const serviceMinsCalc = await getDurationMins(booking.serviceType, booking.units);
 const blockMins = slot.blockMins || (serviceMinsCalc + (slot.travelBufferMins || 0));
 const price = booking.price || await getPriceFromTable(booking.serviceType, booking.units);

 let placedStartMins = slot.placedStartMins;
 let placedEndMins = slot.placedEndMins;
 let placedReservedEndMins = slot.placedReservedEndMins;
 let timeChanged = false;
 let placementNote = '';

 if (placement && placement.start) {
 const re = placeWindowInBlock(slot, serviceMinsCalc, blockMins, placement.start);
 if (!re.ok) {
 const suggestPart = re.suggest ? `\n💡 Try: <code>/confirm ${inboxId} ${optionIdx} @ ${re.suggest}</code>` : '';
 return { success: false, message: `❌ ${re.reason}${suggestPart}` };
 }
 if (re.placedStartMins !== slot.placedStartMins) timeChanged = true;
 placedStartMins = re.placedStartMins;
 if (placement.end) {
 const endParsed = parseHHMM(placement.end);
 if (endParsed !== null && endParsed > re.placedStartMins) {
 placedEndMins = endParsed;
 placementNote = ' (hardcoded window)';
 } else {
 placedEndMins = re.placedEndMins;
 }
 } else {
 placedEndMins = re.placedEndMins;
 }
 placedReservedEndMins = re.placedReservedEndMins;
 } else if (placedStartMins === undefined) {
 const re = placeWindowInBlock(slot, serviceMinsCalc, blockMins);
 if (re.ok) {
 placedStartMins = re.placedStartMins;
 placedEndMins = re.placedEndMins;
 placedReservedEndMins = re.placedReservedEndMins;
 }
 }

 const placedStartTxt = placedStartMins !== undefined ? format12h(placedStartMins) : (slot.Block_Start || '');
 const placedEndTxt = placedEndMins !== undefined ? format12h(placedEndMins) : (slot.Block_End || '');
 const placedRange12h = `${placedStartTxt}–${placedEndTxt}`;
 const placedHHMMRange = (placedStartMins !== undefined && placedEndMins !== undefined)
 ? `${formatHHMM(placedStartMins)}–${formatHHMM(placedEndMins)}`
 : `${slot.Block_Start || ''}–${slot.Block_End || ''}`;
 const slotDesc = `${slot.Day || ''} ${slot.Date || ''} ${placedRange12h}${placementNote}`.trim();

 let confirmMsg;
 try {
 const tpl = await getTemplate('BOOKING-CONFIRM');
 if (tpl && tpl.Message_Text) {
 confirmMsg = fillTemplate(tpl.Message_Text, {
 Name: pending.contact.Full_Name,
 ServiceType: booking.serviceType,
 Units: booking.units,
 SlotDate: slot.Date || '',
 SlotDay: slot.Day || '',
 SlotTime: placedRange12h,
 SlotTime24: placedHHMMRange,
 SlotBlock: slot.Block || '',
 Address: pending.contact.Address || '',
 Price: price,
 });
 }
 } catch (e) { /* use fallback */ }

 if (!confirmMsg) {
 const lead = timeChanged ? `📅 Your appointment time has been updated.\n\n` : `🎉 Your appointment is confirmed!\n\n`;
 confirmMsg =
 lead +
 `Service: ${booking.serviceType} ×${booking.units} unit(s)\n` +
 `Date: ${slot.Day || ''} ${slot.Date || ''}\n` +
 `Time: ${slot.Block || ''} (${placedStartTxt}–${placedEndTxt})\n` +
 `Address: ${pending.contact.Address || ''}\n` +
 `Total: $${price} SGD\n\n` +
 `We'll send you a reminder before the appointment. Thank you for choosing KoolAircon! 😊`;
 }

 pending.draftReply = confirmMsg;
 let computedPlacedEndHHMM = '';
 if (placedReservedEndMins !== undefined) {
 computedPlacedEndHHMM = formatHHMM(placedReservedEndMins);
 } else if (placedEndMins !== undefined) {
 computedPlacedEndHHMM = formatHHMM(placedEndMins);
 }

 pending.finalizationContext = {
 slot: { ...slot, placedStartMins, placedEndMins, placedReservedEndMins },
 serviceType: booking.serviceType,
 units: booking.units,
 price, blockMins,
 address: pending.contact.Address || '',
 phone: pending.contact.Phone || '',
 postalCode: booking.postalCode,
 placedStartHHMM: placedStartMins !== undefined ? formatHHMM(placedStartMins) : '',
 placedEndHHMM: computedPlacedEndHHMM,
 };
 pending.bookingContext = null;
 pendingApprovals.set(inboxId, pending);

 const timeChangeLine = timeChanged ? `⚠️ <b>Time changed</b> from original offer.\n` : '';
 await makeNotify(notifyFn, pending.contact, inboxId)(
 `🧾 <b>${inboxId} — ready to confirm booking</b>\n` +
 `Contact: ${pending.contact.Full_Name} (${pending.contact.Contact_ID})\n` +
 `Slot: Option ${optionIdx} — ${slotDesc}\n` +
 timeChangeLine +
 `Block: ${blockMins} mins reserved\n` +
 `Price: $${price} SGD\n\n` +
 `📝 <b>Draft confirmation message:</b>\n${confirmMsg}\n\n` +
 `<code>${inboxId}</code> — ✅ send confirmation + create job\n` +
 `<code>${inboxId} your text</code> — ✏️ override message\n` +
 `<code>/confirm ${inboxId} ${optionIdx} @ HH:MM</code> — 🔄 change start time within this slot`
 );

 return { success: true, inboxId, slot, option: optionIdx, price, timeChanged };
}

// ─── handleConfirmBooking (/confirmb) ────────────────────────────────────────

export async function handleConfirmBooking(args) {
 const { inboxId: requestedInboxId } = args;
 const inboxId = normalizeInboxId(requestedInboxId);
 if (!inboxId) return { success: false, message: '⚠️ Usage: /confirmb INBOX-003' };

 const inboxRow = await findInboxById(inboxId);
 if (!inboxRow) return { success: false, message: `⚠️ No inbox found for ${inboxId}.` };
 const contacts = await getContacts();
 const contact = contacts.find(c => c.Contact_ID === inboxRow.row.Contact_ID);
 if (!contact) return { success: false, message: `⚠️ Contact not found for ${inboxId}.` };

 const events = await findEventsByInbox(inboxId);
 const futureEvents = events.filter(ev => {
 const startStr = ev.start?.dateTime || ev.start?.date;
 if (!startStr) return false;
 return new Date(startStr).getTime() >= Date.now() - 60 * 60 * 1000;
 });

 if (futureEvents.length === 0) {
 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `⚠️ <b>${inboxId} — no calendar event found</b>\n` +
 `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n\n` +
 `Either:\n` +
 `• Manually create an event in Kool Aircon Bookings calendar with <code>${inboxId}</code> in the title or description, then run <code>/confirmb ${inboxId}</code> again.\n` +
 `• Or use the normal flow: <code>/b ${inboxId} GC 3</code> → customer picks → <code>/confirm ${inboxId} 1</code>.`
 );
 return { success: false, reason: 'no_event', message: 'No calendar event found for this inbox.' };
 }

 futureEvents.sort((a, b) => {
 const ax = new Date(a.start?.dateTime || a.start?.date).getTime();
 const bx = new Date(b.start?.dateTime || b.start?.date).getTime();
 return ax - bx;
 });
 const ev = futureEvents[0];

 const meta = calParseDescription(ev.description);
 const titleParts = calExtractFromTitle(ev.summary);
 const startDate = new Date(ev.start.dateTime || ev.start.date);
 const endDate = new Date(ev.end.dateTime || ev.end.date);
 const startParts = sgtPartsFromDate(startDate);
 const endParts = sgtPartsFromDate(endDate);

 const serviceType = (meta.service || '').toUpperCase() || (ev.summary?.match(/\b(GC|CW|CO|AS)\b/) || [])[0] || 'GC';
 const units = parseInt(meta.units || (ev.summary?.match(/×(\d+)/) || [])[1] || '1', 10);
 const price = parseInt(meta.price_sgd, 10) > 0 ? parseInt(meta.price_sgd, 10) : await getPriceFromTable(serviceType, units);
 const address = meta.address || contact.Address || '';
 const phone = meta.phone || contact.Phone || '';
 const postal = meta.postal || contact.Postal_Code || '';
 const zoneId = meta.zone || '';

 const dayName = startDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Singapore' });
 const slotTime12 = `${format12h(startParts.mins)}–${format12h(endParts.mins)}`;
 const slotTime24 = `${startParts.hhmm}–${endParts.hhmm}`;

 let confirmMsg;
 try {
 const tpl = await getTemplate('BOOKING-CONFIRM');
 if (tpl && tpl.Message_Text) {
 confirmMsg = fillTemplate(tpl.Message_Text, {
 Name: contact.Full_Name, ServiceType: serviceType, Units: units,
 SlotDate: startParts.date, SlotDay: dayName, SlotTime: slotTime12,
 SlotTime24: slotTime24, SlotBlock: '', Address: address, Price: price,
 });
 }
 } catch (e) { /* fallback */ }

 if (!confirmMsg) {
 confirmMsg =
 `🎉 Your appointment is confirmed!\n\n` +
 `Service: ${serviceType} ×${units} unit(s)\n` +
 `Date: ${dayName} ${startParts.date}\n` +
 `Time: ${slotTime12}\n` +
 `Address: ${address}\n` +
 `Total: $${price} SGD\n\n` +
 `We'll send you a reminder before the appointment. Thank you for choosing KoolAircon! 😊`;
 }

 const pending = {
 inboxId, rowNum: inboxRow.rowNum, contact,
 contactChannelId: contact.Channel_Contact_ID,
 draftReply: confirmMsg,
 customerMessage: inboxRow.row.Customer_Message || '',
 timestamp: new Date().toISOString(),
 finalizationContext: {
 slot: {
 Date: startParts.date, Day: dayName, Block: '',
 Block_Start: startParts.hhmm, Block_End: endParts.hhmm,
 Primary_Zone: zoneId, Mins_Remaining: '0',
 placedStartMins: startParts.mins, placedEndMins: endParts.mins,
 placedReservedEndMins: endParts.mins,
 },
 serviceType, units, price,
 blockMins: endParts.mins - startParts.mins,
 address, phone, postalCode: postal,
 placedStartHHMM: startParts.hhmm,
 placedEndHHMM: endParts.hhmm,
 calendarEventId: ev.id,
 existingEventStatus: ev.status,
 },
 };
 pendingApprovals.set(inboxId, pending);

 const eventStateTag = ev.status === 'confirmed' ? '✅ confirmed' : '🕓 tentative';
 const manualNote = (!meta.contact_id && !titleParts.contactId)
 ? `\n⚠️ Event title/description did not contain a contact id — matched via inbox tag only.`
 : '';

 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `🧾 <b>${inboxId} — calendar-confirmed booking ready</b>\n` +
 `Contact: ${contact.Full_Name} (${contact.Contact_ID})\n` +
 `Event: ${eventStateTag} — "${ev.summary || '(no title)'}"\n` +
 `When: ${dayName} ${startParts.date} ${slotTime12} (SGT)\n` +
 `Service: ${serviceType} ×${units}\n` +
 `Price: $${price} SGD${manualNote}\n\n` +
 `📝 <b>Draft confirmation message:</b>\n${confirmMsg}\n\n` +
 `<code>${inboxId}</code> — ✅ send confirmation + create job\n` +
 `<code>${inboxId} your text</code> — ✏️ override message`
 );

 return { success: true, inboxId, eventId: ev.id, start: startParts.date, time: slotTime12 };
}

// ─── handleCheckCal ───────────────────────────────────────────────────────────

export async function handleCheckCal() {
 const now = new Date();
 const future = new Date();
 future.setDate(future.getDate() + 30);

 let rawEvents = [];
 try {
 const teams = await getTeamCalendars();
 const seen = new Set();
 for (const team of teams) {
 const teamEvents = await listEvents(now, future, {}, team.Calendar_ID);
 for (const ev of teamEvents) {
 if (seen.has(ev.id)) continue;
 seen.add(ev.id);
 rawEvents.push({ event: ev, calCalendarId: team.Calendar_ID });
 }
 }
 } catch (err) {
 console.error('[booking] handleCheckCal calendar fetch error:', err.message);
 throw new Error(`Could not read calendar: ${err.message}`);
 }

 const processed = [];

 for (const { event, calCalendarId } of rawEvents) {
 const title = event.summary || '';
 const desc = event.description || '';
 const parsedDesc = calParseDescription(desc);
 if (parsedDesc?.job_id) continue;

 let contact = null;
 let contactId = null;
 let isNew = false;

 const kaMatch = title.match(/\b(KA-\d{3,4})\b/i);
 const newMatch = title.match(/\bnew\b/i);

 if (kaMatch) {
 contactId = kaMatch[1].toUpperCase();
 const contacts = await getContacts();
 contact = contacts.find(c => c.Contact_ID === contactId);
 if (!contact) {
 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `⚠️ /checkCal: Event "${title}" has ${contactId} but no matching contact in sheet.\n` +
 `Create the contact first or use NEW in the title for a new customer.`
 );
 continue;
 }
 } else if (newMatch) {
 isNew = true;
 const contacts = await getContacts();
 const lastId = contacts
 .map(c => parseInt((c.Contact_ID || '').replace('KA-', ''), 10))
 .filter(n => !isNaN(n))
 .reduce((max, n) => Math.max(max, n), 0);
 const nextNum = String(lastId + 1).padStart(4, '0');
 contactId = `KA-${nextNum}`;

 const afterNew = title.replace(/\bnew\b/i, '').trim();
 const strippedForName = afterNew
 .replace(/\b(GC|CW|CO|IN|GAS|REPAIR|INSTALL|INSTALLATION|CONDENSER)\b/gi, '')
 .replace(/\b\d+\s*(units?)?\b/gi, '')
 .replace(/[×x]\s*\d+/gi, '')
 .trim();
 const parsedName = strippedForName.length > 1 ? strippedForName : '';

 contact = await createContact({
 Contact_ID: contactId,
 Full_Name: parsedName || `New Customer ${contactId}`,
 Contact_Status: 'Lead',
 Primary_Channel: 'Telegram',
 Source: 'Manual Calendar',
 Created_Date: new Date().toISOString().split('T')[0],
 });

 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `✅ New contact created: ${contactId}${parsedName ? ` — ${parsedName}` : ''}\n` +
 `Status: Lead\nRun /info to add their details.`
 );
 } else {
 continue;
 }

 const svcMatch = title.match(/\b(GC|CW|CO|G\.C|C\.W|C\.O|Install(?:ation)?|Gas|Repair|Condenser)\b/i);
 const rawService = svcMatch ? svcMatch[1].toUpperCase().replace('.','') : null;
 const unitsMatch = title.match(/[×x]\s*(\d+)|(\d+)\s*unit|\b([1-9])\s*$/i);
 const units = unitsMatch ? parseInt(unitsMatch[1] || unitsMatch[2] || unitsMatch[3], 10) : null;
 const svcLabel = rawService ? serviceTypeLabel(rawService) : null;

 const eventStart = event.start?.dateTime || event.start?.date || '';
 const eventEnd = event.end?.dateTime || event.end?.date || '';
 const startDate = new Date(eventStart);
 const endDate = new Date(eventEnd);
 const dateStr = fmtCheckCalDate(startDate);
 const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][startDate.getDay()];
 const startHHMM = fmtCheckCalHHMM(startDate);
 const endHHMM = fmtCheckCalHHMM(endDate);

 const missing = [];
 if (!rawService || !units) missing.push('service_units');
 if (!contact?.Address) missing.push('address');
 if (!contact?.Postal_Code) missing.push('postal');
 if (!contact?.Phone && !contact?.Channel_Contact_ID) missing.push('phone');

 let zoneId = '';
 if (contact?.Postal_Code) {
 try {
 const zone = await getZoneFromPostal(contact.Postal_Code);
 zoneId = zone?.Zone_ID || '';
 } catch (e) { /* ignore */ }
 }

 const inboxId = await addToInbox({
 Contact_ID: contactId,
 Contact_Name: contact.Full_Name,
 Customer_Message: '(Manual calendar event)',
 Draft_Reply: '(awaiting /checkCal confirmation)',
 Channel: contact.Primary_Channel || 'Telegram',
 Status: 'Pending',
 });

 const fullTitle = [
 contactId,
 contact.Full_Name !== `New Customer ${contactId}` ? contact.Full_Name : null,
 svcLabel && units ? `${svcLabel} ×${units}` : null,
 `[${inboxId}]`,
 ].filter(Boolean).join(' — ');

 const fullDesc = calBuildDescription({
 contact_id: contactId,
 service: rawService || '',
 units: units ? String(units) : '',
 address: contact?.Address || '',
 postal: contact?.Postal_Code || '',
 phone: contact?.Phone || contact?.Channel_Contact_ID || '',
 zone: zoneId,
 });

 try {
 await calUpdateEvent(event.id, { summary: fullTitle, description: fullDesc }, calCalendarId);
 } catch (err) {
 console.warn('[booking] handleCheckCal could not update event:', err.message);
 }

 const timeStr = `${fmtCheckCal12h(startHHMM)}–${fmtCheckCal12h(endHHMM)}`;
 const prompts = [];
 if (missing.includes('service_units')) {
 prompts.push(`🔧 Service & units missing:\n <code>/calinfo ${inboxId} GC 3</code> — replace GC and 3 with actual values`);
 }
 if (missing.includes('address') || missing.includes('postal') || missing.includes('phone')) {
 const missingFields = [
 missing.includes('address') ? 'address' : null,
 missing.includes('postal') ? 'postal code' : null,
 missing.includes('phone') ? 'phone' : null,
 ].filter(Boolean).join(', ');
 prompts.push(`📋 Missing: ${missingFields}\n <code>/info ${inboxId} [address] | [postal] | [phone]</code>`);
 }

 const hasMissing = missing.length > 0;
 let confirmMsg = '';
 if (!hasMissing) {
 confirmMsg =
 `Hi ${contact.Full_Name}! We've confirmed your KoolAircon appointment 😊\n\n` +
 `📅 ${dayName}, ${dateStr}\n` +
 `🕐 ${timeStr}\n` +
 `🔧 ${svcLabel} — ${units} unit${units > 1 ? 's' : ''}\n` +
 `📍 ${contact.Address}\n\n` +
 `Our team will be there on time. Any questions, just message us!`;
 }

 pendingApprovals.set(inboxId, {
 inboxId, contact,
 contactChannelId: contact.Channel_Contact_ID || contact.Phone,
 draftReply: confirmMsg || '(complete missing fields first)',
 customerMessage: '(Manual calendar event)',
 timestamp: new Date().toISOString(),
 calEventId: event.id,
 calCalendarId,
 calDate: dateStr,
 calStartHHMM: startHHMM,
 calEndHHMM: endHHMM,
 serviceType: rawService || '',
 units: units || null,
 isManualCalEvent: true,
 missingFields: missing,
 });

 let operatorMsg =
 `📅 <b>/checkCal — ${isNew ? 'New customer' : 'Manual event'} found</b>\n\n` +
 `Contact: ${contact.Full_Name} (${contactId})${isNew ? ' 🆕' : ''}\n` +
 `Date: ${dayName}, ${dateStr}\n` +
 `Time: ${timeStr}\n`;

 if (rawService && units) {
 operatorMsg += `Service: ${svcLabel} × ${units} unit${units > 1 ? 's' : ''}\n`;
 }

 if (hasMissing) {
 operatorMsg += `\n⚠️ <b>Missing info — cannot confirm yet:</b>\n` + prompts.join('\n\n');
 } else {
 operatorMsg +=
 `\n📝 Draft confirmation ready.\n\n` +
 `<code>${inboxId}</code> — send to customer + create job\n` +
 `<code>${inboxId} your message</code> — edit first`;
 }

 await sendTelegram(OPERATOR_TELEGRAM_ID, operatorMsg);
 processed.push({ inboxId, contactName: contact.Full_Name, date: dateStr, time: timeStr, missing });
 }

 return { found: processed.length, processed };
}

// ─── handleCalInfo ────────────────────────────────────────────────────────────

export async function handleCalInfo({ inboxId, serviceType, units }) {
 const pending = pendingApprovals.get(inboxId);
 if (!pending) return { success: false, message: `No pending booking found for ${inboxId}. Run /checkCal first.` };
 if (!pending.isManualCalEvent) return { success: false, message: `${inboxId} is not a manual calendar booking.` };

 const unitsNum = typeof units === 'number' ? units : parseInt(String(units), 10);
 if (!Number.isInteger(unitsNum) || unitsNum < 1) {
 pending.draftReply = '(complete missing fields first)';
 pendingApprovals.set(inboxId, pending);
 return { success: false, message: `⚠️ Units must be a valid number greater than 0. Example: /calinfo ${inboxId} GC 1` };
 }

 pending.serviceType = serviceType;
 pending.units = units;
 const svcLabel = serviceTypeLabel(serviceType);
 const contact = pending.contact;

 const missing = [];
 if (!contact?.Address) missing.push('address');
 if (!contact?.Postal_Code) missing.push('postal code');
 if (!contact?.Phone && !contact?.Channel_Contact_ID) missing.push('phone');

 let zoneId = '';
 try {
 const zone = await getZoneFromPostal(contact?.Postal_Code || '');
 zoneId = zone?.Zone_ID || '';
 } catch (e) { /* ignore */ }

 const fullDesc = calBuildDescription({
 contact_id: contact.Contact_ID,
 service: serviceType,
 units: String(units),
 address: contact?.Address || '',
 postal: contact?.Postal_Code || '',
 phone: contact?.Phone || contact?.Channel_Contact_ID || '',
 zone: zoneId,
 });

 if (pending.calEventId) {
 try {
 const newTitle = `${contact.Contact_ID} — ${contact.Full_Name} — ${svcLabel} ×${units} [${inboxId}]`;
 await calUpdateEvent(pending.calEventId, { summary: newTitle, description: fullDesc }, pending.calCalendarId);
 } catch (err) {
 console.warn('[booking] handleCalInfo could not update calendar event:', err.message);
 }
 }

 const readyToConfirm = missing.length === 0;

 if (readyToConfirm) {
 const confirmMsg =
 `Hi ${contact.Full_Name}! We've confirmed your KoolAircon appointment 😊\n\n` +
 `📅 ${pending.calDate ? pending.calDate : 'TBC'}\n` +
 `🕐 ${pending.calStartHHMM ? fmtCheckCal12h(pending.calStartHHMM) : ''}–${pending.calEndHHMM ? fmtCheckCal12h(pending.calEndHHMM) : ''}\n` +
 `🔧 ${svcLabel} — ${units} unit${units > 1 ? 's' : ''}\n` +
 `📍 ${contact.Address}\n\n` +
 `Our team will be there on time. Any questions, just message us!`;

 pending.draftReply = confirmMsg;
 pending.missingFields = [];

 await sendTelegram(
 OPERATOR_TELEGRAM_ID,
 `✅ ${inboxId} — all info complete!\n\n` +
 `📝 Draft confirmation:\n${confirmMsg}\n\n` +
 `<code>${inboxId}</code> — send to customer + create job\n` +
 `<code>${inboxId} your message</code> — edit first`
 );
 }

 pendingApprovals.set(inboxId, pending);
 return {
 success: true,
 inboxId,
 serviceType,
 units,
 readyToConfirm,
 missingFields: missing,
 };
}
