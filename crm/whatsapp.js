/**
 * whatsapp.js — WhatsApp Cloud API helpers for KoolAircon CRM
 *
 * Handles webhook verification (GET) and outbound message delivery (sendWhatsApp).
 * Inbound customer messages are routed through handleInboundMessage in bot.js.
 * Operator approval commands from WhatsApp are routed through handleOperatorApproval in bot.js.
 *
 * WHATSAPP_ACCESS_TOKEN: set via process.env (injected by supervisord).
 * WHATSAPP_VERIFY_TOKEN: paste this value into Meta's developer console once.
 */

import * as db from './db.js';

// ── Config ────────────────────────────────────────────────────────────────────

export const PHONE_NUMBER_ID = "1148898708312929";
export const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

export const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

export const WHATSAPP_OPERATOR_NUMBER = ''; // Operator commands via Telegram only
// ── Startup credential validation ─────────────────────────────────────────────
if (!WHATSAPP_ACCESS_TOKEN) {
 throw new Error('[whatsapp] FATAL: WHATSAPP_ACCESS_TOKEN env var is not set. Add it to the supervisord environment= line and restart.');
}
if (!WHATSAPP_VERIFY_TOKEN) {
 throw new Error('[whatsapp] FATAL: WHATSAPP_VERIFY_TOKEN env var is not set. Add it to the supervisord environment= line and restart.');
}


// ── sendWhatsApp ──────────────────────────────────────────────────────────────

/**
 * Send a plain-text WhatsApp message via the Cloud API.
 *
 * @param {string} to   - Recipient phone number in E.164 format (e.g. "6591234567")
 * @param {string} text - Message body
 * @returns {Promise<object>} Parsed JSON response from Meta
 */
export async function sendWhatsApp(to, text) {
  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new Error("[whatsapp] WHATSAPP_ACCESS_TOKEN is not set — cannot send message.");
  }

  const url = `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const body = JSON.stringify({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text },
  });

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
    });
  } catch (err) {
    console.error("[whatsapp] Network error sending message:", err);
    throw err;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("[whatsapp] Failed to parse response JSON:", err);
    throw new Error(`[whatsapp] Non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    console.error("[whatsapp] API error response:", JSON.stringify(json));
    throw new Error(
      `[whatsapp] Send failed — HTTP ${res.status}: ${json?.error?.message ?? JSON.stringify(json)}`
    );
  }

  console.log("[whatsapp] Message sent:", JSON.stringify(json));
  await db.insert({
    conversation_id: String(to),
    channel: 'whatsapp',
    direction: 'outbound',
    message_type: 'bot-resp',
    text,
    sender: 'operator',
  }).catch(e => console.error('[whatsapp] db log failed:', e.message));
  return json;
}

// ─── Media upload ─────────────────────────────────────────────────────────────

/**
 * uploadWhatsAppMedia — uploads a file to Meta's media API.
 * Returns the media ID for use in template headers or media messages.
 *
 * @param {Buffer|string} fileData — file buffer or base64 string
 * @param {string} mimeType — e.g. 'video/mp4', 'image/jpeg'
 * @param {string} filename — e.g. 'dirty_water.mp4'
 */
export async function uploadWhatsAppMedia(fileData, mimeType, filename) {
  const { getSettings } = await import('./sheets.js');
  const settings = await getSettings();
  const phoneNumberId = settings.WA_Phone_Number_ID || WHATSAPP_PHONE_NUMBER_ID;

  const form = new FormData();
  const buffer = typeof fileData === 'string'
    ? Buffer.from(fileData, 'base64')
    : fileData;

  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('type', mimeType);

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/media`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
      body: form,
    }
  );

  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error(`[whatsapp] uploadWhatsAppMedia failed: ${JSON.stringify(data)}`);
  }
  console.log(`[whatsapp] Media uploaded: ${data.id} (${filename})`);
  return data.id;
}

// ─── Send template message ────────────────────────────────────────────────────

/**
 * sendWhatsAppTemplate — sends a pre-approved Meta template message.
 *
 * @param {string} to — recipient phone number (E.164 format, e.g. '6591234567')
 * @param {string} waTemplateName — template name as registered with Meta
 * @param {object} params — named parameter values { name: 'John', ... }
 * @param {string} [headerMediaId] — Meta media ID for video/image header (optional)
 */
export async function sendWhatsAppTemplate(to, waTemplateName, params = {}, headerMediaId = null) {
  const { getSettings } = await import('./sheets.js');
  const { getSendComponents, getTemplateRegistry } = await import('./templates.js');

  const settings = await getSettings();
  const phoneNumberId = settings.WA_Phone_Number_ID || WHATSAPP_PHONE_NUMBER_ID;

  const registry = getTemplateRegistry();
  const def = registry[waTemplateName];
  if (!def) throw new Error(`[whatsapp] Unknown template: ${waTemplateName}`);

  const components = await getSendComponents(waTemplateName, params, settings, headerMediaId);

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to).replace(/^\+/, ''),
    type: 'template',
    template: {
      name: waTemplateName,
      language: { code: def.language || 'en_US' },
      components,
    },
  };

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`[whatsapp] sendWhatsAppTemplate failed: ${JSON.stringify(data)}`);
  }
  console.log(`[whatsapp] Template sent: ${waTemplateName} → ${to} (msg: ${data.messages?.[0]?.id})`);
  await db.insert({
    conversation_id: String(to),
    channel: 'whatsapp',
    direction: 'outbound',
    message_type: 'bot-resp',
    text: `[template:${waTemplateName}]`,
    sender: 'operator',
  }).catch(e => console.error('[whatsapp] db log failed:', e.message));
  return data;
}

// ─── Send media message (service message in FEP window) ───────────────────────

/**
 * sendWhatsAppMedia — sends an image or video as a free-form service message.
 * Only usable within an open 24-hour customer service window (FEP).
 *
 * @param {string} to — recipient phone number
 * @param {'image'|'video'|'document'} mediaType
 * @param {string} mediaId — Meta media ID (from uploadWhatsAppMedia)
 * @param {string} [caption] — optional caption text
 */
export async function sendWhatsAppMedia(to, mediaType, mediaId, caption = '') {
  const { getSettings } = await import('./sheets.js');
  const settings = await getSettings();
  const phoneNumberId = settings.WA_Phone_Number_ID || WHATSAPP_PHONE_NUMBER_ID;

  const mediaPayload = { id: mediaId };
  if (caption && ['image', 'video', 'document'].includes(mediaType)) {
    mediaPayload.caption = caption;
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to).replace(/^\+/, ''),
    type: mediaType,
    [mediaType]: mediaPayload,
  };

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`[whatsapp] sendWhatsAppMedia failed: ${JSON.stringify(data)}`);
  }
  console.log(`[whatsapp] Media sent: ${mediaType} → ${to} (msg: ${data.messages?.[0]?.id})`);
  await db.insert({
    conversation_id: String(to),
    channel: 'whatsapp',
    direction: 'outbound',
    message_type: 'bot-resp',
    text: `[${mediaType}] ${caption}`,
    sender: 'operator',
  }).catch(e => console.error('[whatsapp] db log failed:', e.message));
  return data;
}

// ─── Send interactive message (service message with buttons) ──────────────────

/**
 * sendWhatsAppInteractive — sends a service message with reply buttons or CTA.
 * Only usable within an open 24-hour customer service window (FEP).
 *
 * @param {string} to — recipient phone number
 * @param {string} bodyText — message body
 * @param {Array} buttons — array of { type: 'reply'|'url', id, title, url? }
 * @param {string} [headerText] — optional text header
 * @param {string} [footerText] — optional footer
 */
export async function sendWhatsAppInteractive(to, bodyText, buttons, headerText = '', footerText = '') {
  const { getSettings } = await import('./sheets.js');
  const settings = await getSettings();
  const phoneNumberId = settings.WA_Phone_Number_ID || WHATSAPP_PHONE_NUMBER_ID;

  const hasUrl = buttons.some(b => b.type === 'url');
  const interactiveType = hasUrl ? 'cta_url' : 'button';

  let interactivePayload;

  if (interactiveType === 'button') {
    interactivePayload = {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({
          type: 'reply',
          reply: { id: b.id || b.title, title: b.title },
        })),
      },
    };
  } else {
    const urlBtn = buttons.find(b => b.type === 'url');
    interactivePayload = {
      type: 'cta_url',
      body: { text: bodyText },
      action: {
        name: 'cta_url',
        parameters: { display_text: urlBtn.title, url: urlBtn.url },
      },
    };
  }

  if (headerText) interactivePayload.header = { type: 'text', text: headerText };
  if (footerText) interactivePayload.footer = { text: footerText };

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to).replace(/^\+/, ''),
    type: 'interactive',
    interactive: interactivePayload,
  };

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`[whatsapp] sendWhatsAppInteractive failed: ${JSON.stringify(data)}`);
  }
  console.log(`[whatsapp] Interactive sent → ${to} (msg: ${data.messages?.[0]?.id})`);
  await db.insert({
    conversation_id: String(to),
    channel: 'whatsapp',
    direction: 'outbound',
    message_type: 'bot-resp',
    text: bodyText,
    sender: 'operator',
  }).catch(e => console.error('[whatsapp] db log failed:', e.message));
  return data;
}

// ─── Register template with Meta ──────────────────────────────────────────────

/**
 * registerWhatsAppTemplate — submits a template to Meta for approval.
 * Only needs to be run once per template. Status will be PENDING until Meta approves.
 *
 * @param {string} waTemplateName — template name from registry
 * @param {string} bodyText — message body from 4_Templates sheet
 */
export async function registerWhatsAppTemplate(waTemplateName, bodyText) {
  const { getSettings } = await import('./sheets.js');
  const { getTemplateComponents } = await import('./templates.js');

  const settings = await getSettings();
  const wabaId = settings.WA_WABA_ID;
  if (!wabaId) throw new Error('[whatsapp] WA_WABA_ID not set in 9_Settings');

  const { category, language, components } = await getTemplateComponents(
    waTemplateName, bodyText, settings
  );

  const payload = {
    name: waTemplateName,
    language,
    category: category.toUpperCase(),
    parameter_format: 'named',
    components,
  };

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`[whatsapp] registerWhatsAppTemplate failed: ${JSON.stringify(data)}`);
  }
  console.log(`[whatsapp] Template registered: ${waTemplateName} (id: ${data.id}, status: ${data.status})`);
  return data;
}

// ─── Fallback phone number ID constant ───────────────────────────────────────
const WHATSAPP_PHONE_NUMBER_ID = '1261834007009399';

