/**
 * KoolAircon CRM Plugin
 *
 * Intercepts inbound Telegram messages and routes them through the KoolAircon
 * human-in-the-loop CRM instead of the normal AI assistant.
 *
 * COMMAND REFERENCE:
 *   /info INBOX-001 123 Main St #05-10 | 410123 | 91234567
 *     — Save customer's address, postal code, and phone number
 *   /b INBOX-001 GC 3
 *     — Generate 3 booking slots (postal pulled from saved contact)
 *   INBOX-001 (or /in INBOX-001)
 *     — Send the current draft to the customer
 *   INBOX-001 custom message here
 *     — Send a custom message to the customer
 *   /confirm INBOX-001 2
 *     — Customer chose option 2 → draft confirmation, create job on approval
 *   /asCustomer <msg>
 *     — Self-test as a customer (sender id TEST-9999)
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { WHATSAPP_VERIFY_TOKEN, WHATSAPP_OPERATOR_NUMBER, sendWhatsApp } from "../../../crm/whatsapp.js";
import { getSettings, purgeOperatorInbox, getContacts, findInboxById } from "../../../crm/sheets.js";
import * as db from "../../../crm/db.js";
import { pollTechnicianSubmissions } from "../../../crm/module3.js";
import { handleSendPhotosCommand, isPhotoYesReply } from "../../../crm/crm.js";
import { broadcastToUI } from "../../../crm/broadcast.js";
import {
  handleInboundMessage,
  handleOperatorApproval,
  handleBookingCommand,
  handleConfirmSlot,
  handleConfirmBooking,
  syncCalendarToJobs,
  detectAndMarkCompletedJobs,
  runDailyReminderSweep,
  handleInfoCommand,
  handleMixYes,
  handleMixNo,
  handleCheckCal,
  handleCalInfo,
  isQueueApprovalText,
  handleQueueApproval,
  OPERATOR_TELEGRAM_ID,
} from "../../../crm/bot.js";
const TEST_CUSTOMER_ID = "TEST-9999";
const TEST_CUSTOMER_NAME = "Test Customer";

type SenderInfo = { senderId: string; senderName?: string; content: string; timestamp?: number };
const senderBySession = new Map<string, SenderInfo>();

function telegramUserIdFromSessionKey(sessionKey: string | undefined): string | null {
  if (!sessionKey) return null;
  const m = sessionKey.match(/^agent:[^:]+:telegram:direct:(.+)$/);
  return m ? m[1] : null;
}

// Detect inbox-approval syntax: "IN-001", "INBOX-001", optionally followed by custom text.
function isInboxApprovalText(text: string): boolean {
  return /^\/?(?:INBOX|IN)-\d+(?:\s+[\s\S]+)?$/i.test(text.trim());
}

function normalizeApprovalText(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}
let syncInFlight = false;
let sweepRanToday = ''; // tracks the date the sweep last ran in-process

// Resolves a command result's inboxId/contactId to the customer's channel-native
// id (Telegram chat id or WhatsApp number) so command-result rows land in the
// same messages.db thread as everything else for that customer — matching the
// conversation_id convention every other db.insert() call site already uses
// (see db.js's header comment). Falls back to the raw id string only if no
// contact record resolves, so nothing is silently dropped.
async function persistCommandResult(result: any) {
  if (!result || typeof result.text !== "string") return;
  const rawId = result.contactId || result.inboxId;
  if (!rawId) return;
  try {
    const contacts = await getContacts();
    let contact: any = null;
    if (result.contactId) {
      contact = contacts.find((c: any) => c.Contact_ID === result.contactId);
    } else if (result.inboxId) {
      const inboxRow = await findInboxById(result.inboxId);
      if (inboxRow) contact = contacts.find((c: any) => c.Contact_ID === inboxRow.row.Contact_ID);
    }
    const conversationId = contact?.Channel_Contact_ID || rawId;
    const channel = (contact?.Source || "").includes("WhatsApp") ? "whatsapp" : "telegram";
    await db.insert({
      conversation_id: String(conversationId),
      channel,
      direction: "outbound",
      message_type: "bot-resp",
      text: result.text,
      sender: "operator",
    });
  } catch (e) {
    console.error("[index] command-result db log failed:", e instanceof Error ? e.message : String(e));
  }
}

// Wraps api.registerCommand so every command's { text } reply also reaches the
// browser UI via broadcastToUI, and is persisted to messages.db (long-poll's
// only data source until Phase 3b's WebSocket exists) — Phase 2's notifyFn
// threading covers the handlers that message the operator directly
// (handleBookingCommand, handleConfirmSlot); this covers the rest, whose
// replies flow back through the command framework's own return-value
// mechanism instead (e.g. /calinfo).
function registerUICommand(api: any, config: any) {
  const originalHandler = config.handler;
  api.registerCommand({
    ...config,
    handler: async (...args: any[]) => {
      const result = await originalHandler(...args);
      if (result && typeof result.text === "string") {
        broadcastToUI({ type: "command-result", text: result.text, timestamp: Date.now() });
        persistCommandResult(result).catch((e: unknown) =>
          console.error("[index] persistCommandResult failed:", e instanceof Error ? e.message : String(e))
        );
      }
      return result;
    },
  });
}

export default definePluginEntry({
  id: "koolaircon-crm",
  name: "KoolAircon CRM",
  description: "Human-in-the-loop Telegram CRM for KoolAircon",

  register(api) {
    api.logger.info("KoolAircon CRM plugin registered");

    // ── /info INBOX-001 123 Main St #05-10 | 410123 | 91234567 ───────────────
    registerUICommand(api, {
      name: "info",
      description: "Save customer address, postal code, phone. Usage: /info INBOX-001 123 Main St #05-10 | 410123 | 91234567",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim();
        if (!args) {
          return {
            text:
              "⚠️ Usage:\n" +
              "• `/info INBOX-001 123 Main St | 410123 | 91234567` — positional\n" +
              "• `/info INBOX-001 Full_Name: Mrs Tan | Phone: 91234567` — named fields\n" +
              "• `/info KA-0001 Full_Name: Mrs Tan` — update by Contact_ID\n\n" +
              "Updatable fields: Full_Name, Address, Postal_Code, Phone, Email, Type, Notes",
          };
        }

        // Parse prefix: INBOX-NNN or KA-XXXX
        const prefixMatch = args.match(/^(IN(?:BOX)?-\d+|KA-\d{3,4})\s+(.+)$/i);
        if (!prefixMatch) {
          return { text: "❌ Format: `/info INBOX-001 ...` or `/info KA-0001 ...`" };
        }

        const [, prefix, rest] = prefixMatch;

        // Check if named field format (contains "FieldName:")
        const isNamed = /[A-Za-z_]+\s*:/.test(rest);

        if (isNamed) {
          // Parse named fields: Full_Name: Mrs Tan | Phone: 91234567
          const namedFields: Record<string, string> = {};
          const parts = rest.split('|').map(s => s.trim());
          for (const part of parts) {
            const m = part.match(/^([A-Za-z_]+)\s*:\s*(.+)$/);
            if (m) namedFields[m[1].trim()] = m[2].trim();
          }
          try {
            const result = await handleInfoCommand({
              inboxId: prefix, namedFields,
            });
            if (result.success) return { text: `✅ ${result.inboxId} — contact updated.` };
            return { text: `⚠️ ${result.message}` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `❌ Error: ${msg}`, isError: true };
          }
        } else {
          // Positional format: address | postal | phone
          const m = rest.match(/^(.+?)\s*\|\s*(\d{6})\s*\|\s*([\d\s+\-]+)$/);
          if (!m) {
            return {
              text:
                "❌ Positional format: `/info INBOX-001 <address> | <6-digit postal> | <phone>`\n" +
                "Or named: `/info INBOX-001 Full_Name: Mrs Tan | Phone: 91234567`",
            };
          }
          const [, address, postalCode, phone] = m;
          try {
            const result = await handleInfoCommand({
              inboxId: prefix,
              address: address.trim(),
              postalCode: postalCode.trim(),
              phone: phone.trim(),
            });
            if (result.success) {
              return {
                text:
                  `✅ ${result.inboxId} — contact details saved.\n` +
                  `Now run: \`/b ${result.inboxId} GC 3\` to generate booking slots.`,
              };
            }
            return { text: `⚠️ ${result.message}` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `❌ Error: ${msg}`, isError: true };
          }
        }
      },
    });

    // ── /confirm INBOX-001 2 ──────────────────────────────────────────────────
    registerUICommand(api, {
      name: "confirm",
      description: "Confirm slot. Usage: /confirm INBOX-001 2  |  /confirm INBOX-001 2 @ 14:30  |  /confirm INBOX-001 2 @ 15:15-16:15",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim();
        if (!args) {
          return {
            text:
              "⚠️ Usage:\n" +
              "• `/confirm INBOX-001 2` — earliest fit in slot 2\n" +
              "• `/confirm INBOX-001 2 @ 14:30` — start at 14:30 within slot 2\n" +
              "• `/confirm INBOX-001 2 @ 15:15-16:15` — hardcoded window",
          };
        }

        // Parse: INBOX-001 2 [@ HH:MM] [@ HH:MM-HH:MM]
        const m = args.match(/^(IN(?:BOX)?-\d+)\s+(\d+)(?:\s*@\s*(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?)?\s*$/i);
        if (!m) {
          return {
            text:
              "❌ Format:\n" +
              "• `/confirm INBOX-001 2`\n" +
              "• `/confirm INBOX-001 2 @ 14:30`\n" +
              "• `/confirm INBOX-001 2 @ 15:15-16:15`",
          };
        }

        const [, inboxId, choice, startTime, endTime] = m;
        const placement = startTime ? { start: startTime, end: endTime } : undefined;
        try {
          const result = await handleConfirmSlot({
            inboxId: inboxId.trim(),
            choice: choice.trim(),
            placement,
          });
          if (result.success) {
            const changeNote = result.timeChanged ? " (time updated)" : "";
            return {
              text:
                `✅ ${result.inboxId} — slot ${result.option} selected${changeNote}.\n` +
                `Draft confirmation ready. Reply \`${result.inboxId}\` (or \`/in ${result.inboxId}\`) to send + create job.`,
            };
          }
          return { text: `⚠️ ${result.message ?? result.reason}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ Error: ${msg}`, isError: true };
        }
      },
    });

    // ── /confirmb INBOX-003 (calendar-driven override) ─────────────────────
    registerUICommand(api, {
      name: "confirmb",
      description:
        "Confirm a booking from a Google Calendar event (manual or bot-created). Usage: /confirmb INBOX-003",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim();
        if (!args) {
          return {
            text:
              "⚠️ Usage: `/confirmb INBOX-003`\n\n" +
              "Looks up the calendar event tagged with this inbox id in the **Kool Aircon Bookings** Google Calendar.\n" +
              "If you created it manually, put the inbox id in the title (e.g. `KA-0003 GC ×2 INBOX-003`) or in the description.\n" +
              "Then approve with `INBOX-003` to send the confirmation and create the job.",
          };
        }
        const m = args.match(/^(IN(?:BOX)?-\d+)\s*$/i);
        if (!m) {
          return { text: "❌ Format: `/confirmb INBOX-003`" };
        }
        try {
          const result = await handleConfirmBooking({ inboxId: m[1].toUpperCase() });
          if (result.success) {
            return {
              text:
                `✅ ${result.inboxId} — calendar event matched (${result.start} ${result.time}).\n` +
                `Draft confirmation ready. Reply \`${result.inboxId}\` to send + create job.`,
            };
          }
          return { text: `⚠️ ${result.message ?? result.reason}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ Error: ${msg}`, isError: true };
        }
      },
    });

    // ── /b INBOX-001 GC 3 ─────────────────────────────────────────────────────
    registerUICommand(api, {
      name: "b",
      description: "Generate 3 booking slots. Usage: /b INBOX-001 GC 3 (postal pulled from saved contact info)",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim();
        if (!args) {
          return {
            text:
              "⚠️ Usage: `/b INBOX-001 GC 3`\n" +
              "Postal code is pulled from the saved contact record (set with /info).\n\n" +
              "Service codes: GC (General Clean), CW (Chemical Wash), CO (Chemical Overhaul), IN (Installation)",
          };
        }

        // Format: INBOX-001 GC 3  OR  KA-0004 GC 3
        const m = args.match(/^(IN(?:BOX)?-\d+|KA-\d{3,4})\s+([A-Z]{2})\s+(\d{1,2})$/i);
        if (!m) {
          return {
            text:
              "❌ Format: `/b INBOX-001 <service> <units>`\n" +
              "Example: `/b INBOX-001 GC 3`\n" +
              "Run `/info INBOX-001 ...` first to save the customer's postal code.",
          };
        }

        const [, prefix, serviceType, unitsStr] = m;
        const prefixUpper = prefix.toUpperCase();
        const isContactId = prefixUpper.startsWith("KA-");

        try {
          const result = await handleBookingCommand({
            inboxId: !isContactId ? prefixUpper : undefined,
            contactId: isContactId ? prefixUpper : undefined,
            serviceType: serviceType.toUpperCase(),
            units: parseInt(unitsStr, 10),
          });
          if (result.success) {
            return {
              text:
                `✅ ${result.inboxId} — ${result.slots.length} slot(s) drafted.\n` +
                `Check Telegram for the draft. Reply \`${result.inboxId}\` to send to customer.`,
            };
          }
          return { text: `⚠️ ${result.message ?? result.reason}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ Error: ${msg}`, isError: true };
        }
      },
    });

    // ── /in INBOX-001 [custom text] ───────────────────────────────────────────
    registerUICommand(api, {
      name: "in",
      description: "Approve a pending inbox item. Usage: /in INBOX-001  OR  /in INBOX-001 your custom reply",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim();
        if (!args) {
          return { text: "⚠️ Usage: `/in INBOX-001` (send draft) or `/in INBOX-001 your text` (override)" };
        }
        try {
          const result = await handleOperatorApproval({ text: args });
          if (result.success) {
            return { text: `✅ ${result.inboxId} processed.` };
          }
          return { text: `⚠️ ${result.reason ?? "no_match"} — check Telegram for the pending queue.` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ Error: ${msg}`, isError: true };
        }
      },
    });

    // ── /asCustomer <message> ─────────────────────────────────────────────────
    registerUICommand(api, {
      name: "checkCal",
      description: "Scan Google Calendar for manually-created events with a Contact_ID but no job yet.",
      acceptsArgs: false,
      requireAuth: true,
      async handler(ctx) {
        try {
          const result = await handleCheckCal();
          if (result.found === 0) {
            return {
              text:
                "✅ Calendar checked — no new manual events found.\n\n" +
                "To add a manual booking: create an event in \"Kool Aircon Bookings\" " +
                "with the Contact_ID (e.g. KA-0001) in the title, then run /checkCal again.",
            };
          }
          const lines = result.processed.map(
            (p: any) =>
              `• ${p.inboxId} — ${p.contactName} on ${p.date} ${p.time}\n` +
              "  Reply `" + p.inboxId + "` to send confirmation and create job."
          );
          return {
            text:
              `✅ Found ${result.found} new manual event(s):\n\n` +
              lines.join('\n\n') +
              `\n\nCheck Telegram for the drafted confirmation messages.`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ /checkCal error: ${msg}`, isError: true };
        }
      },
    });

    // ── /calinfo INBOX-006 CW 3 ───────────────────────────────────────────────────
    registerUICommand(api, {
      name: "calinfo",
      description: "Set service type and units for a manual calendar booking. Usage: /calinfo INBOX-006 CW 3",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim();
        if (!args) {
          return {
            text:
              "⚠️ Usage: `/calinfo INBOX-006 GC 3`\n\n" +
              "Service codes: GC (General Clean), CW (Chemical Wash), " +
              "CO (Chemical Overhaul), IN (Installation)",
          };
        }

        const m = args.match(/^(IN(?:BOX)?-\d+)\s+([A-Z]{2})\s+(\d{1,2})$/i);
        if (!m) {
          return {
            text:
              "❌ Format: `/calinfo INBOX-006 GC 3`\n" +
              "Service codes: GC, CW, CO, IN",
          };
        }

        const [, inboxId, serviceType, unitsStr] = m;
        try {
          const result = await handleCalInfo({
            inboxId:     inboxId.toUpperCase(),
            serviceType: serviceType.toUpperCase(),
            units:       parseInt(unitsStr, 10),
          });
          if (result.success) {
            return {
              text:
                `✅ ${result.inboxId} — service set to ${result.serviceType} × ${result.units} units.\n\n` +
                (result.readyToConfirm
                  ? `Draft confirmation ready. Reply \`${result.inboxId}\` to send to customer.`
                  : `Still missing: ${result.stillMissing.join(', ')}.\n` +
                    `Run /info ${result.inboxId} [address] | [postal] | [phone] to complete.`),
            };
          }
          return { text: `⚠️ ${result.message}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ /calinfo error: ${msg}`, isError: true };
        }
      },
    });

    // ── /asCustomer <message> ─────────────────────────────────────────────
    registerUICommand(api, {
      name: "asCustomer",
      description: "Self-test: simulate an inbound customer message. Usage: /asCustomer [<name>] <message>",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const raw = ctx.args?.trim();
        if (!raw) {
          return {
            text:
              "⚠️ Usage:\n" +
              "• `/asCustomer <message>` — default Test Customer\n" +
              "• `/asCustomer <name> <message>` — simulate a specific customer\n" +
              "• `/asCustomer <name>: <message>` — colon-separated form\n\n" +
              "Examples:\n" +
              "• `/asCustomer Hi, I want to book GC for 2 units`\n" +
              "• `/asCustomer KellyAW Hi I need an aircon service`\n" +
              "• `/asCustomer Duri.G: do you service Tampines?`",
          };
        }

        // Parse: optional name token + optional colon + message.
        // Heuristic: treat first token as a customer name if it looks name-shaped
        // (CamelCase, dotted, or with digits) or if a ":"/"-" separator was used.
        // This avoids eating ordinary words like "Hi" / "Hello" as a name.
        let contactId = TEST_CUSTOMER_ID;
        let senderName = TEST_CUSTOMER_NAME;
        let text = raw;

        const named = raw.match(/^([A-Za-z][A-Za-z0-9._-]{0,40})\s*([:\-])?\s+(.+)$/s);
        if (named) {
          const nameToken = named[1];
          const separator = named[2];
          const rest = named[3].trim();
          const looksLikeName =
            !!separator ||
            /[A-Z][a-z]+[A-Z]/.test(nameToken) ||  // CamelCase like KellyAW
            /\./.test(nameToken) ||                 // dotted like Duri.G
            /\d/.test(nameToken);                   // has a digit
          if (looksLikeName && rest.length > 0) {
            senderName = nameToken;
            const testSuffix = Date.now().toString().slice(-4);
            contactId = `TEST-${nameToken}-${testSuffix}`;
            text = rest;
          }
        }

        try {
          await handleInboundMessage({
            contactId,
            senderName,
            text,
            timestamp: new Date().toISOString(),
          });
          const whoLabel = contactId === TEST_CUSTOMER_ID
            ? senderName
            : `${senderName} (${contactId})`;
          return {
            text:
              `✅ Simulated customer message sent through CRM:\n` +
              `From: ${whoLabel}\n\n"${text}"\n\n` +
              `Check your Telegram for the operator notification.`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ CRM error: ${msg}`, isError: true };
        }
      },
    });

    // ── /mixyes INBOX-005 ──────────────────────────────────────────────────────
    registerUICommand(api, {
      name: "mixyes",
      description: "Repeat customer open to another team. Re-runs slot search across all teams. Usage: /mixyes INBOX-005",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim();
        if (!args) {
          return { text: "⚠️ Usage: `/mixyes INBOX-005`\n\nRe-runs the slot search without team filter so any team can take the job." };
        }
        const m = args.match(/^(IN(?:BOX)?-\d+)\s*$/i);
        if (!m) {
          return { text: "❌ Format: `/mixyes INBOX-005`" };
        }
        try {
          const result = await handleMixYes(m[1].toUpperCase());
          if (result.success) {
            return {
              text:
                `✅ ${result.inboxId} — ${result.slots.length} slot(s) found across all teams.\n` +
                `Check Telegram for the draft. Reply \`${result.inboxId}\` to send to customer.`,
            };
          }
          return { text: `⚠️ ${result.message ?? result.reason}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ /mixyes error: ${msg}`, isError: true };
        }
      },
    });

    // ── /mixno INBOX-005 ───────────────────────────────────────────────────────
    registerUICommand(api, {
      name: "mixno",
      description: "Repeat customer wants home team only. Re-runs slot search with home-team filter, shows results regardless of date. Usage: /mixno INBOX-005",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const args = ctx.args?.trim();
        if (!args) {
          return { text: "⚠️ Usage: `/mixno INBOX-005`\n\nRe-runs the slot search with the customer's home team only." };
        }
        const m = args.match(/^(IN(?:BOX)?-\d+)\s*$/i);
        if (!m) {
          return { text: "❌ Format: `/mixno INBOX-005`" };
        }
        try {
          const result = await handleMixNo(m[1].toUpperCase());
          if (result.success) {
            return {
              text:
                `✅ ${result.inboxId} — ${result.slots.length} slot(s) found (home team).\n` +
                `Check Telegram for the draft. Reply \`${result.inboxId}\` to send to customer.`,
            };
          }
          return { text: `⚠️ ${result.message ?? result.reason}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `❌ /mixno error: ${msg}`, isError: true };
        }
      },
    });

    // ── message_received: cache sender info ───────────────────────────────────
    api.on("message_received", async (event) => {
      if (!event.sessionKey) return;
      const senderId = event.senderId ? String(event.senderId) : "";
      if (!senderId) return;
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      const senderName = typeof meta.senderName === "string" ? meta.senderName.trim() : "";
      const senderUsername = typeof meta.senderUsername === "string" ? meta.senderUsername.trim() : "";
      const fromStr = typeof event.from === "string" ? event.from : "";
      const fallbackFrom = fromStr && !fromStr.includes(":") && fromStr !== senderId ? fromStr : "";
      const displayName = senderName || senderUsername || fallbackFrom || undefined;

      senderBySession.set(event.sessionKey, {
        senderId,
        senderName: displayName,
        content: event.content ?? "",
        timestamp: event.timestamp,
      });
    });

    // ── before_agent_reply: route Telegram messages through CRM ──────────────
    api.on(
      "before_agent_reply",
      async (event, ctx) => {
        const sessionKey = ctx.sessionKey;
        const telegramUserId = telegramUserIdFromSessionKey(sessionKey);
        if (!telegramUserId) return;

        const text = (event.cleanedBody ?? "").trim();
        if (!text) return;

        const cached = sessionKey ? senderBySession.get(sessionKey) : undefined;
        const senderName = cached?.senderName;
        const isOperator = telegramUserId === OPERATOR_TELEGRAM_ID;

        api.logger.info(
          `[CRM] ${isOperator ? "Operator" : `Customer ${telegramUserId}`} ${senderName ? `(${senderName}) ` : ""}→ "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`,
        );

        try {
          if (isOperator) {
            // Queue approval: Q-NNN
            const queueSeq = isQueueApprovalText(text);
            if (queueSeq) {
              let queueReply = '';
              await handleQueueApproval(queueSeq, (msg: string) => { queueReply = msg; });
              return { handled: true, reply: { text: queueReply || 'NO_REPLY' } };
            }
            if (!isInboxApprovalText(text)) return;
            await handleOperatorApproval({ text: normalizeApprovalText(text) });
          } else {
            await handleInboundMessage({
              contactId: telegramUserId,
              senderName,
              text,
              timestamp:
                event && (event as any).timestamp
                  ? new Date((event as any).timestamp).toISOString()
                  : new Date().toISOString(),
            });
          }
          return { handled: true, reply: { text: "NO_REPLY" } };
        } catch (err) {
          api.logger.error(
            `[CRM] Handler error: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      },
      { priority: 100 },
    );

    // ── WhatsApp webhook: GET (verify) + POST (inbound events) ─────────────────
    api.registerHttpRoute({
      path: "/webhook/whatsapp",
      auth: "plugin",
      match: "exact",
      handler: async (req: any, res: any) => {
        if (req.method === "GET") {
          // Meta hub verification handshake
          const rawUrl = req.url ?? "";
          const base = `http://localhost${rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl}`;
          const url = new URL(base);
          const mode      = url.searchParams.get("hub.mode");
          const token     = url.searchParams.get("hub.verify_token");
          const challenge = url.searchParams.get("hub.challenge");

          if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
            api.logger.info("[whatsapp] Webhook verified by Meta.");
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(challenge ?? "");
          } else {
            api.logger.warn(`[whatsapp] Verify failed — mode=${mode}, token=${token}`);
            res.writeHead(403);
            res.end();
          }
          return true;
        }

        if (req.method === "POST") {
          // Collect raw body first — Meta requires a fast 200 regardless of processing.
          let rawBody = "";
          await new Promise<void>((resolve, reject) => {
            req.on("data", (chunk: any) => { rawBody += chunk.toString(); });
            req.on("end", () => resolve());
            req.on("error", reject);
          });
          res.writeHead(200);
          res.end();

          // Process asynchronously after 200 is sent.
          (async () => {
            let payload: any;
            try {
              payload = JSON.parse(rawBody);
            } catch {
              api.logger.warn("[whatsapp] POST body was not valid JSON — ignored.");
              return;
            }

            // Defensively extract sender + text — not all POSTs are user messages
            // (Meta also sends delivery receipts, read receipts, status updates, etc.)
            let from: string | undefined;
            let body: string | undefined;
            try {
              const msg = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
              if (msg?.type === "text") {
                from = msg.from;        // E.164 without +, e.g. "6591234567"
                body = msg.text?.body;
              }
            } catch {
              // unexpected shape — fall through and ignore
            }

            if (!from || !body) {
              // Status update / delivery receipt / non-text message — nothing to do.
              api.logger.info("[whatsapp] webhook POST received (no actionable message).");
              return;
            }

            api.logger.info(`[whatsapp] message from ${from}: ${body.slice(0, 80)}`);

            if (from === WHATSAPP_OPERATOR_NUMBER) {
              // ── Operator command path ──────────────────────────────────────────────────
              // Queue approval: Q-NNN
              const queueSeqWA = isQueueApprovalText(body);
              if (queueSeqWA) {
                const waNotify = (text: string) => sendWhatsApp(WHATSAPP_OPERATOR_NUMBER, text);
                await handleQueueApproval(queueSeqWA, waNotify).catch((err) =>
                  api.logger.error(`[whatsapp] handleQueueApproval error: ${err instanceof Error ? err.message : String(err)}`)
                );
                return;
              }
              if (!isInboxApprovalText(body)) {
                api.logger.info("[whatsapp] operator message is not an inbox command — ignored.");
                return;
              }
              const notifyFn = (text: string) => sendWhatsApp(WHATSAPP_OPERATOR_NUMBER, text);
              try {
                await handleOperatorApproval(
                  { text: normalizeApprovalText(body) },
                  { notifyFn },
                );
              } catch (err) {
                api.logger.error(`[whatsapp] handleOperatorApproval error: ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              // ── Customer message path ────────────────────────────────────────────────
              await handleInboundMessage({
                contactId: from,
                text: body,
                timestamp: Date.now(),
                senderName: from, // WhatsApp doesn't give us a display name from the webhook payload, so use the number as senderName for now
                channel: 'WhatsApp',
              });
            }
          })().catch((err) =>
            api.logger.error(`[whatsapp] async processing error: ${err instanceof Error ? err.message : String(err)}`)
          );

          return true;
        }

        // Any other HTTP method
        res.writeHead(405);
        res.end();
        return true;
      },
    });

    // ── 15-minute calendar → jobs sync ──────────────────────────────────────────

    // ── GET /booking/slots ─────────────────────────────────────────────────────
    api.registerHttpRoute({
      path: '/booking/slots',
      auth: 'plugin',
      match: 'exact',
      handler: async (req, res) => {
        // Helper: send JSON response using raw Node http.ServerResponse
        const sendJson = (statusCode, data) => {
          const body = JSON.stringify(data);
          res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, ngrok-skip-browser-warning',
            'Access-Control-Max-Age': '86400',
          });
          res.end(body);
        };

        // Handle preflight
        // Handle preflight — must include all headers the browser will check
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, ngrok-skip-browser-warning',
            'Access-Control-Max-Age': '86400',
          });
          res.end();
          return true;
        }

        try {
          // Parse query params from req.url
          const urlObj = new URL(req.url, 'http://localhost');
          const postal = urlObj.searchParams.get('postal');
          const service = urlObj.searchParams.get('service');
          const units = urlObj.searchParams.get('units');
          const phone = urlObj.searchParams.get('phone') || '';

          if (!postal || !service || !units) {
            return sendJson(400, { error: 'Missing required params: postal, service, units' });
          }

          const { getZoneFromPostal, findAvailableSlots, getDurationMins } = await import('../../../crm/scheduler.js');
          const { getContacts, getPriceFromTable } = await import('../../../crm/sheets.js');

          let assignedTeam = '';
          if (phone) {
            const contacts = await getContacts();
            const norm = phone.replace(/D/g, '').replace(/^65/, '');
            const existing = contacts.find(c =>
              (c.Phone || '').replace(/D/g, '').replace(/^65/, '') === norm ||
              (c.Channel_Contact_ID || '').replace(/D/g, '').replace(/^65/, '') === norm
            );
            if (existing?.Assigned_Team) assignedTeam = existing.Assigned_Team;
          }

          const zone = await getZoneFromPostal(String(postal));
          if (!zone) {
            return sendJson(200, { slots: [], dates: {}, noZone: true });
          }

          const unitsNum = parseInt(units, 10) || 1;
          const durationMins = await getDurationMins(service.toUpperCase(), unitsNum);
          const price = await getPriceFromTable(service.toUpperCase(), unitsNum);

          const rawSlots = await findAvailableSlots(zone.Zone_ID, durationMins, 30, assignedTeam);

          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowSGT = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
          const maxDate = new Date();
          maxDate.setDate(maxDate.getDate() + 14);
          const maxDateSGT = maxDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

          const fmtTime = (mins) => {
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            const period = h >= 12 ? 'pm' : 'am';
            const h12 = h % 12 || 12;
            return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2,'0')}${period}`;
          };

          // Group by date — expand each block into all valid 30-min start times
          const BLOCK_SIZE = 30; // minutes
          const parseHHMM = (hhmm: string) => {
            const [h, m] = (hhmm || '').split(':').map(Number);
            return h * 60 + m;
          };
          const byDate: Record<string, any[]> = {};
          for (const slot of rawSlots) {
            if (slot.Date < tomorrowSGT || slot.Date > maxDateSGT) continue;
            if (!byDate[slot.Date]) byDate[slot.Date] = [];

            // Enumerate all valid start times within this block
            // A start time is valid if job ends by block end
            const blockStartMins = parseHHMM(slot.Block_Start);
            const blockEndMins   = parseHHMM(slot.Block_End);
            let startMins = blockStartMins;
            while (startMins + durationMins <= blockEndMins) {
              const endMins = startMins + durationMins;
              byDate[slot.Date].push({
                start: fmtTime(startMins),
                end: fmtTime(endMins),
                startMins,
                endMins,
                block: slot.Block,
                day: slot.Day,
              });
              startMins += BLOCK_SIZE;
            }
          }

          // Deduplicate (same date+startMins from multiple team results) and sort
          for (const dateStr of Object.keys(byDate)) {
            const seen = new Set<string>();
            byDate[dateStr] = byDate[dateStr].filter(s => {
              const key = `${s.startMins}-${s.endMins}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            byDate[dateStr].sort((a, b) => a.startMins - b.startMins);
          }

          const allDates = {};
          const cur = new Date(tomorrow);
          while (true) {
            const dateStr = cur.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
            if (dateStr > maxDateSGT) break;
            const dayName = cur.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Singapore' });
            allDates[dateStr] = {
              day: dayName,
              available: !!byDate[dateStr],
              slots: byDate[dateStr] || [],
            };
            cur.setDate(cur.getDate() + 1);
          }

          return sendJson(200, {
            zone: zone.Zone_ID,
            durationMins,
            price,
            isReturningCustomer: !!assignedTeam,
            dates: allDates,
          });

        } catch (err) {
          api.logger.error('[booking] /booking/slots error:', err.message);
          return sendJson(500, { error: 'Failed to fetch slots. Please try again.' });
        }
      },
    });

    // ── KoolAircon CRM web interface (Phase 3 — long-poll, no WebSocket yet) ───
    // UI_PASSWORD is a single shared password (env var, set via supervisord
    // environment=). No user accounts — checked against every request below.
    // Note on dynamic segments: /booking/slots and /webhook/whatsapp are the
    // only proven registerHttpRoute patterns available (a literal path with
    // match: 'exact', dynamic values taken from the query string) — there's
    // no confirmed :param/prefix-matching support, so routes that the spec
    // describes as e.g. /api/messages/:contactId are registered here as
    // /api/messages?contactId=... instead, deliberately avoiding the same
    // class of unverified-framework-behavior risk the WebSocket probe just
    // caught. These are stubs; Phase 4/5 fill in real logic.
    function requireUIAuth(req: any, res: any): boolean {
      const UI_PASSWORD = process.env.UI_PASSWORD;
      const sendUnauthorized = () => {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Basic realm="KoolAircon CRM"',
        });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
      };
      if (!UI_PASSWORD) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UI_PASSWORD not configured on server' }));
        return false;
      }
      const authHeader = String(req.headers['authorization'] || '');
      const match = authHeader.match(/^Basic\s+(.+)$/);
      let password = '';
      if (match) {
        try {
          const decoded = Buffer.from(match[1], 'base64').toString('utf8');
          password = decoded.slice(decoded.indexOf(':') + 1);
        } catch { /* malformed header — password stays empty, falls through to 401 */ }
      }
      if (password !== UI_PASSWORD) {
        sendUnauthorized();
        return false;
      }
      return true;
    }

    function sendUIJson(res: any, statusCode: number, data: any) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }

    // ── GET /ui — placeholder page (real interface is Phase 4) ────────────────
    api.registerHttpRoute({
      path: '/ui',
      auth: 'plugin',
      match: 'exact',
      handler: async (req: any, res: any) => {
        if (!requireUIAuth(req, res)) return true;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body><p>KoolAircon CRM — interface coming in Phase 4.</p></body></html>');
        return true;
      },
    });

    // ── GET /api/updates?since=<timestamp> — long-poll endpoint ────────────────
    api.registerHttpRoute({
      path: '/api/updates',
      auth: 'plugin',
      match: 'exact',
      handler: async (req: any, res: any) => {
        if (!requireUIAuth(req, res)) return true;
        try {
          const urlObj = new URL(req.url, 'http://localhost');
          const since = parseInt(urlObj.searchParams.get('since') || '0', 10) || 0;
          const messages = await db.getMessagesSince(since);
          sendUIJson(res, 200, { messages, now: Date.now() });
        } catch (err) {
          api.logger.error('[ui] /api/updates error:', err instanceof Error ? err.message : String(err));
          sendUIJson(res, 500, { error: 'Failed to fetch updates.' });
        }
        return true;
      },
    });

    // ── GET /api/threads — stub, real data in Phase 4 ──────────────────────────
    api.registerHttpRoute({
      path: '/api/threads',
      auth: 'plugin',
      match: 'exact',
      handler: async (req: any, res: any) => {
        if (!requireUIAuth(req, res)) return true;
        sendUIJson(res, 200, { ok: true, threads: [] });
        return true;
      },
    });

    // ── GET /api/messages?contactId=... — stub, real data in Phase 4 ──────────
    api.registerHttpRoute({
      path: '/api/messages',
      auth: 'plugin',
      match: 'exact',
      handler: async (req: any, res: any) => {
        if (!requireUIAuth(req, res)) return true;
        const urlObj = new URL(req.url, 'http://localhost');
        const contactId = urlObj.searchParams.get('contactId') || '';
        sendUIJson(res, 200, { ok: true, contactId, messages: [] });
        return true;
      },
    });

    // ── GET /api/customer?contactId=... — stub, real data in Phase 4/5 ────────
    api.registerHttpRoute({
      path: '/api/customer',
      auth: 'plugin',
      match: 'exact',
      handler: async (req: any, res: any) => {
        if (!requireUIAuth(req, res)) return true;
        const urlObj = new URL(req.url, 'http://localhost');
        const contactId = urlObj.searchParams.get('contactId') || '';
        sendUIJson(res, 200, { ok: true, contactId, customer: null });
        return true;
      },
    });

    // ── GET /api/queue — stub, real data in Phase 7 ────────────────────────────
    api.registerHttpRoute({
      path: '/api/queue',
      auth: 'plugin',
      match: 'exact',
      handler: async (req: any, res: any) => {
        if (!requireUIAuth(req, res)) return true;
        sendUIJson(res, 200, { ok: true, queue: [] });
        return true;
      },
    });

    // ── GET /api/calendar?date=YYYY-MM-DD — stub, real data in Phase 4 ─────────
    api.registerHttpRoute({
      path: '/api/calendar',
      auth: 'plugin',
      match: 'exact',
      handler: async (req: any, res: any) => {
        if (!requireUIAuth(req, res)) return true;
        const urlObj = new URL(req.url, 'http://localhost');
        const date = urlObj.searchParams.get('date') || '';
        sendUIJson(res, 200, { ok: true, date, events: [] });
        return true;
      },
    });

    // ── POST /api/send — stub, real Path A send logic in Phase 5 ───────────────
    api.registerHttpRoute({
      path: '/api/send',
      auth: 'plugin',
      match: 'exact',
      handler: async (req: any, res: any) => {
        if (!requireUIAuth(req, res)) return true;
        if (req.method !== 'POST') {
          sendUIJson(res, 405, { error: 'Method not allowed' });
          return true;
        }
        let rawBody = '';
        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: any) => { rawBody += chunk.toString(); });
          req.on('end', () => resolve());
          req.on('error', reject);
        });
        sendUIJson(res, 200, { ok: true, received: rawBody.length > 0 });
        return true;
      },
    });

    // Pull manually-created or bot-confirmed events from Google Calendar and
    // create Job rows in 2_Jobs for any that don't already have one.
    const SYNC_INTERVAL_MS = 15 * 60 * 1000;
    const runSync = async () => {
      if (syncInFlight) return;
      syncInFlight = true;
      try {
        // ── Block 1: Calendar → Jobs sync ──────────────────────────────────────
        try {
          const result = await syncCalendarToJobs({ lookBackDays: 1, lookAheadDays: 30 });
          if (result.created.length > 0 || result.failed.length > 0) {
            api.logger.info(
              `[CRM] Calendar sync: created=${result.created.length}, skipped=${result.skipped.length}, failed=${result.failed.length}`,
            );
          }
        } catch (err) {
          api.logger.error(
            `[CRM] Calendar sync error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // ── Block 2: Completion detection ───────────────────────────────────────
        try {
          const compResult = await detectAndMarkCompletedJobs();
          if (compResult.processed > 0) {
            api.logger.info(
              `[CRM] Completion detection: processed=${compResult.processed}, ok=${compResult.results.filter((r: any) => r.status === 'ok').length}, errors=${compResult.results.filter((r: any) => r.status === 'error').length}`,
            );
          }
        } catch (err) {
          api.logger.error(
            `[CRM] Completion detection error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // ── Block 4: Technician submission poller ───────────────────────────────
        try {
          const pollResult = await pollTechnicianSubmissions();
          if (pollResult.processed > 0) {
            api.logger.info(
              `[CRM] Technician submissions: processed=${pollResult.processed}, errors=${pollResult.errors}`,
            );
          }
        } catch (err) {
          api.logger.error(
            `[CRM] Technician poll error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // ── Block 3: Daily reminder-tier sweep (C+ND templates) ─────────────────
        // Runs at most once per calendar day (SGT), gated by Module3_Last_Run_Date
        // in 9_Settings.  Every 15-min tick checks the gate; only the first tick
        // of the day actually runs the sweep.
        const sweepHour = parseInt((await getSettings()).Sweep_Hour_SGT ?? '8', 10);
          const nowSGT = new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore', hour: 'numeric', hour12: false });
          const todayDateSGT = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
          if (parseInt(nowSGT, 10) === sweepHour && sweepRanToday !== todayDateSGT) {
            sweepRanToday = todayDateSGT; // set IMMEDIATELY before any await
            try {
              const sweepResult = await runDailyReminderSweep();
              if (!sweepResult.skipped && (sweepResult.draftsGenerated ?? 0) > 0) {
                api.logger.info(`[CRM] Daily reminder sweep: ${sweepResult.draftsGenerated} draft(s) generated`);
              }
            } catch (err) {
              sweepRanToday = ''; // reset on error so it can retry next tick
              api.logger.error(`[CRM] Daily reminder sweep error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Inbox purge — runs daily alongside the sweep
          if (parseInt(nowSGT, 10) === sweepHour && sweepRanToday === todayDateSGT) {
            try {
              const purgeDays = parseInt((await getSettings()).Inbox_Purge_Days ?? '7', 10);
              if (purgeDays > 0) {
                const purgeResult = await purgeOperatorInbox(purgeDays);
                if (purgeResult.purged > 0) {
                  api.logger.info(`[CRM] Inbox purged: ${purgeResult.purged} old entries removed`);
                }
              }
            } catch (err) {
              api.logger.error(`[CRM] Inbox purge error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
      } finally {
        // Always release the lock, even if an unexpected error escapes a block.
        syncInFlight = false;
      }
    };
    // Run once shortly after startup so manual events are picked up on plugin reload.
    setTimeout(runSync, 30 * 1000);
    const syncTimer: any = setInterval(runSync, SYNC_INTERVAL_MS);
    // Unref so the timer doesn't keep the process alive on shutdown.
    if (syncTimer && typeof syncTimer.unref === 'function') syncTimer.unref();
    // ── /sendphotos ────────────────────────────────────────────────────────────
    registerUICommand(api, {
      name: 'sendphotos',
      description: 'Send the photo bundle for a completed job to the customer. Usage: /sendphotos INBOX-001',
      acceptsArgs: true,
      requireAuth: false,
      handler: async ({ args, reply }) => {
        const inboxId = (args || '').trim();
        if (!inboxId) {
          await reply('⚠️ Usage: /sendphotos INBOX-001');
          return;
        }
        const force = inboxId.toLowerCase().endsWith(' force');
        const cleanId = inboxId.replace(/\s+force$/i, '').trim();
        const result = await handleSendPhotosCommand(cleanId, force);
        if (!result.success && result.message) {
          await reply(result.message);
        }
      },
    });


  },
});
