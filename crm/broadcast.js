/**
 * broadcast.js — in-memory pub-sub fan-out for the CRM web interface.
 *
 * Phase 2 wires notifyFn responses and command results through
 * broadcastToUI() below. Phase 3's WebSocket server subscribes real
 * clients via onUIMessage() when they connect. Starts with zero
 * subscribers, so broadcastToUI() is a safe no-op until Phase 3 exists —
 * Phase 2 doesn't depend on the WebSocket server being built yet.
 */

const subscribers = new Set();

export function onUIMessage(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function broadcastToUI(message) {
  for (const fn of subscribers) {
    try {
      fn(message);
    } catch (e) {
      console.error('[broadcast] subscriber error:', e.message);
    }
  }
}
