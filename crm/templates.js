/**
 * templates.js — Meta WhatsApp Business API template definitions
 *
 * Defines the complete component structure for every template that requires
 * Meta pre-approval. Message body text is stored in 4_Templates sheet and
 * passed in at send time. This file defines everything else: header type,
 * footer, buttons, and parameter names.
 *
 * Usage:
 * import { getTemplateComponents, getSendComponents } from './templates.js';
 *
 * To register a template with Meta:
 * const components = await getTemplateComponents('kool_service_complete', bodyText, settings);
 *
 * To send an approved template:
 * const components = await getSendComponents('kool_service_complete', params, settings, headerMediaId);
 */

import { getSettings } from './sheets.js';

// ── Template registry ─────────────────────────────────────────────────────────
// Maps WA_Template_Name → template definition.
// Body text is NOT stored here — it comes from 4_Templates sheet at runtime.
// Parameter names must exactly match {{param_name}} placeholders in body text.

const TEMPLATE_REGISTRY = {

  // ── Marketing templates ───────────────────────────────────────────────────

  kool_lead_followup_1: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name'],
    buttons: [
      { type: 'url', text: 'Our Services', url_key: 'URL_Our_Services' },
      { type: 'url', text: 'Book Online', url_key: 'URL_Book_Online' },
    ],
  },

  kool_lead_followup_2: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name'],
    buttons: [
      { type: 'url', text: 'Our Services', url_key: 'URL_Our_Services' },
      { type: 'url', text: 'Book Online', url_key: 'URL_Book_Online' },
      { type: 'quick_reply', text: 'Still considering' },
    ],
  },

  kool_review_request: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name', 'review_link'],
    buttons: [
      { type: 'url', text: 'Leave a Review', url_key: 'URL_Review' },
      { type: 'url', text: 'Referral Programme', url_key: 'URL_Referral' },
    ],
  },

  kool_referral_request: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name', 'customer_phone'],
    buttons: [
      { type: 'url', text: 'Referral Programme', url_key: 'URL_Referral' },
    ],
  },

  kool_reminder_90: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name'],
    buttons: [
      { type: 'url', text: 'Book Online', url_key: 'URL_Book_Online' },
      { type: 'url', text: 'Our Services', url_key: 'URL_Our_Services' },
    ],
  },

  kool_reminder_105: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name'],
    buttons: [
      { type: 'url', text: 'Book Online', url_key: 'URL_Book_Online' },
      { type: 'url', text: 'Our Services', url_key: 'URL_Our_Services' },
    ],
  },

  kool_reminder_180: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name'],
    buttons: [
      { type: 'url', text: 'Book Online', url_key: 'URL_Book_Online' },
      { type: 'url', text: 'Our Services', url_key: 'URL_Our_Services' },
    ],
  },

  kool_reminder_210: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name', 'md_name'],
    buttons: [
      { type: 'url', text: 'Book Online', url_key: 'URL_Book_Online' },
      { type: 'url', text: 'Our Services', url_key: 'URL_Our_Services' },
      { type: 'quick_reply', text: 'I\'d like to reconnect' },
    ],
  },

  kool_reminder_365: {
    category: 'marketing',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name'],
    buttons: [
      { type: 'url', text: 'Book Online', url_key: 'URL_Book_Online' },
      { type: 'url', text: 'Our Services', url_key: 'URL_Our_Services' },
    ],
  },

  // ── Utility templates ─────────────────────────────────────────────────────

  kool_service_complete: {
    category: 'utility',
    language: 'en_US',
    header: { type: 'video' }, // media ID passed at send time per job
    footer: 'KoolAircon | kool.com.sg',
    params: ['name', 'service_type', 'units', 'job_date', 'report_token'],
    buttons: [
      { type: 'quick_reply', text: 'YES' },
      { type: 'url', text: 'View Report', url_key: 'URL_Report', url_suffix_param: 'report_token' },
      { type: 'phone_number', text: 'Contact Us', phone: '+6500000000' },
    ],
  },

  kool_booking_confirm: {
    category: 'utility',
    language: 'en_US',
    header: null,
    footer: 'KoolAircon | kool.com.sg',
    params: ['name', 'service_type', 'units', 'slot_day', 'slot_date', 'slot_time', 'address', 'price'],
    buttons: [],
  },

};

// ── Helper: resolve URL from settings ────────────────────────────────────────

function resolveUrl(button, settings) {
  if (button.type !== 'url') return null;
  const base = settings[button.url_key] || `https://kool.com.sg`;
  if (button.url_suffix_param) {
    return `${base}/{{${button.url_suffix_param}}}`;
  }
  return base;
}

// ── getTemplateComponents ─────────────────────────────────────────────────────
// Returns the components array for registering a template with Meta.
// bodyText: the message body string from 4_Templates sheet (with {{param}} placeholders)

export async function getTemplateComponents(waTemplateName, bodyText, settingsOverride) {
  const def = TEMPLATE_REGISTRY[waTemplateName];
  if (!def) throw new Error(`[templates] Unknown template: ${waTemplateName}`);

  const settings = settingsOverride || await getSettings();
  const components = [];

  // Header
  if (def.header) {
    const headerComp = { type: 'header', format: def.header.type.toUpperCase() };
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerComp.format)) {
      headerComp.example = { header_handle: ['PLACEHOLDER_HANDLE'] };
    } else if (def.header.text) {
      headerComp.text = def.header.text;
    }
    components.push(headerComp);
  }

  // Body
  const bodyComp = {
    type: 'body',
    text: bodyText,
  };
  if (def.params && def.params.length > 0) {
    bodyComp.example = {
      body_text_named_params: def.params.map(p => ({
        param_name: p,
        example: `[${p}_example]`,
      })),
    };
  }
  components.push(bodyComp);

  // Footer
  if (def.footer) {
    components.push({ type: 'footer', text: def.footer });
  }

  // Buttons
  if (def.buttons && def.buttons.length > 0) {
    const buttons = def.buttons.map(btn => {
      if (btn.type === 'quick_reply') {
        return { type: 'quick_reply', text: btn.text };
      }
      if (btn.type === 'phone_number') {
        return { type: 'phone_number', text: btn.text, phone_number: btn.phone };
      }
      if (btn.type === 'url') {
        return { type: 'url', text: btn.text, url: resolveUrl(btn, settings) };
      }
      return btn;
    });
    components.push({ type: 'buttons', buttons });
  }

  return { category: def.category, language: def.language, components };
}

// ── getSendComponents ─────────────────────────────────────────────────────────
// Returns the components array for sending an approved template via Messages API.
// params: { name: 'John', service_type: 'General Clean', ... }
// headerMediaId: Meta media ID (required for video/image header templates)

export async function getSendComponents(waTemplateName, params, settingsOverride, headerMediaId) {
  const def = TEMPLATE_REGISTRY[waTemplateName];
  if (!def) throw new Error(`[templates] Unknown template: ${waTemplateName}`);

  const settings = settingsOverride || await getSettings();
  const components = [];

  // Header component (only if media header and ID provided)
  if (def.header && headerMediaId) {
    components.push({
      type: 'header',
      parameters: [{
        type: def.header.type,
        [def.header.type]: { id: headerMediaId },
      }],
    });
  }

  // Body component with named params
  if (def.params && def.params.length > 0) {
    components.push({
      type: 'body',
      parameters: def.params
        .filter(p => params[p] !== undefined)
        .map(p => ({
          type: 'text',
          parameter_name: p,
          text: String(params[p] ?? ''),
        })),
    });
  }

  // Button components — only needed for dynamic URL suffixes
  const dynamicUrlButtons = def.buttons
    .map((btn, idx) => ({ btn, idx }))
    .filter(({ btn }) => btn.type === 'url' && btn.url_suffix_param && params[btn.url_suffix_param]);

  if (dynamicUrlButtons.length > 0) {
    dynamicUrlButtons.forEach(({ btn, idx }) => {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(idx),
        parameters: [{
          type: 'text',
          text: params[btn.url_suffix_param],
        }],
      });
    });
  }

  return components;
}

// ── getTemplateRegistry ───────────────────────────────────────────────────────
// Returns the full registry — used by registerAllTemplates utility.

export function getTemplateRegistry() {
  return TEMPLATE_REGISTRY;
}
