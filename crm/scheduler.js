/**
 * scheduler.js — v4 ZONE OVERFLOW + TRAVEL BUFFER
 *
 * CONTEXT FOR OPENCLAW:
 * KoolAircon CRM. This replaces scheduler.js v3 (multi-team) with
 * added zone overflow routing and travel buffers between jobs.
 * Multi-team support from v3 is preserved unchanged.
 *
 * WHAT CHANGED FROM v3:
 * ──────────────────────

 * Primary_Day, Overflow_To) instead of hardcoded ZONE_PRIMARY_DAY map.
 * Falls back to hardcoded map if sheet read fails.
 *
 * 2. Overflow zone routing — NEW.
 * If a customer's primary zone day has no slot, the scheduler now

 * column), but ONLY offers PM block (1pm-6pm), never AM.
 * Order: primary zone full day -> overflow zone PM only -> no slot.
 *
 * 3. Travel buffer between jobs — NEW.
 * placedReservedEndMins now adds a buffer on top of the visible
 * service duration:
 * - Same zone as the slot's primary zone: +30 mins
 * - Overflow zone (PM-only slot): +45 mins
 * The buffer is invisible to the customer (visible end time is
 * unaffected) but blocks the calendar so the next job has travel time.
 *
 * 4. 6-day week — Saturday now follows zone rules instead of being

 * (Team_Schedule) where a zone has "Saturday" listed.
 *
 * 5. 3-day urgency rule revised -- no longer offers "any zone, any day".
 * Within 3 days, the scheduler still follows primary -> overflow
 * routing, just doesn't wait for the literal primary day if today+3
 * arrives at an overflow day first.
 *
 * HOW TO APPLY (give to OpenClaw):
 * 1. Back up current scheduler.js:
 * cp ~/.openclaw/workspace/crm/scheduler.js \
 * ~/.openclaw/workspace/crm/scheduler.js.bak_v3
 * 2. Replace scheduler.js with this file's contents in full.
 * 3. No changes needed to bot.js -- same exported function signatures.
 * 4. Restart gateway.
 *
 * SHEET 3A REQUIREMENTS (already exists, no sheet changes needed):
 * Zone_ID | Zone_Name | Primary_Day | Overflow_To | Sector_Prefixes | Areas

 *
 */

import { getPostalZones, getServiceDurations, getTeams, getTeamSchedule, getJobs, getSettings } from './sheets.js';
import { getBusyIntervals } from './calendar.js';

// ─── Fallback for single-team setup (backward compatible) ─────────────────────
const FALLBACK_CALENDAR_ID =
  '5d0a5d4947473f83f855ce090ac206db955492a254ef352a4df2704fc3482e01@group.calendar.google.com';

// ─── Working day blocks, travel buffers, days-ahead window ──────────────────
// Values now read live from 9_Settings sheet via getSettings() per-call.
// Fallbacks (used if sheet read fails) match the original hardcoded values.
// WORK_BLOCKS constructed dynamically in findAvailableSlots().
const DAY_NAME_TO_NUM = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };


// ─── Zone day map cache (loaded from Sheet Team_Schedule) ─────────────────────────────
// TTL: 60 minutes. Changes to Team_Schedule take effect within 60 minutes
// without a gateway restart.
let _zoneDayCache = null;
let _zoneDayCacheTime = 0;
const ZONE_DAY_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Loads per-team, per-day zone schedule from Sheet Team_Schedule.
 * Returns { 'TEAM-A': { 1: { primaryZone, overflowZone }, ... }, 'TEAM-B': { ... } }
 * Day keys use JS day-of-week numbers (1=Monday ... 6=Saturday).
 * Falls back to {} if the sheet read fails — getTeamsForZoneOnDate() will find
 * no candidates and the booking flow will alert the operator rather than guess.
 */
export async function getZoneDayMap() {
  const now = Date.now();
  if (_zoneDayCache && (now - _zoneDayCacheTime) < ZONE_DAY_CACHE_TTL_MS) {
    return _zoneDayCache;
  }

  try {
    const rows = await getTeamSchedule();
    if (!rows || rows.length === 0) throw new Error('Team_Schedule returned no rows');

    const map = {};
    for (const row of rows) {
      const teamId = (row.Team_ID || '').trim();
      const dayNum = DAY_NAME_TO_NUM[(row.Day || '').trim()];
      const primaryZone = (row.Primary_Zone || '').trim();
      const overflowZone = (row.Overflow_To || '').trim();
      if (!teamId || dayNum === undefined || !primaryZone) continue;
      if (!map[teamId]) map[teamId] = {};
      map[teamId][dayNum] = { primaryZone, overflowZone };
    }

    if (Object.keys(map).length === 0) throw new Error('Team_Schedule had no valid rows');
    _zoneDayCache = map;
    _zoneDayCacheTime = Date.now();
    return map;
  } catch (err) {
    console.warn('[scheduler] Team_Schedule read failed, using empty map:', err.message);
    _zoneDayCache = {};
    return {};
  }
}

/**
 * Returns [{ team, bufferMins, isOverflow, pmOnly }] for every team that can
 * work zoneId on the given date, based on Team_Schedule.
 * - primaryZone match → same-zone buffer (BUFFER_SAME_ZONE_MINS), AM+PM
 * - overflowZone match → overflow buffer (BUFFER_OVERFLOW_MINS), PM only
 */
async function getTeamsForZoneOnDate(zoneId, date, allTeams) {
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0) return []; // Sunday closed

  const zoneDayMap = await getZoneDayMap();
  const settings = await getSettings();
  const bufferSameZone = parseInt(settings.Buffer_Same_Zone_Mins ?? '30', 10);
  const bufferOverflow  = parseInt(settings.Buffer_Overflow_Mins  ?? '45', 10);
  const candidates = [];

  for (const team of allTeams) {
    const dayEntry = zoneDayMap[team.Team_ID]?.[dayOfWeek];
    if (!dayEntry) continue;

    if (dayEntry.primaryZone === zoneId) {
      candidates.push({ team, bufferMins: bufferSameZone, isOverflow: false, pmOnly: false });
    } else if (dayEntry.overflowZone === zoneId) {
      candidates.push({ team, bufferMins: bufferOverflow, isOverflow: true, pmOnly: true });
    }
  }

  return candidates;
}

// ─── Get active team calendars from Sheet 3D_Teams (unchanged from v3) ───────
export async function getTeamCalendars(rawTeams = null) {
  try {
    const teams = rawTeams ?? await getTeams();
    const active = teams
      .filter(t => t.Active?.toUpperCase() === 'TRUE' && t.Calendar_ID?.trim())
      .map(t => ({
        Team_ID: t.Team_ID || 'TEAM-A',
        Team_Name: t.Team_Name || 'Team A',
        Calendar_ID: t.Calendar_ID.trim(),
        Primary_Zones: t.Primary_Zones
          ? t.Primary_Zones.split(',').map(z => z.trim()).filter(Boolean)
          : [],
        Technician_Emails: t.Technician_Emails
          ? t.Technician_Emails.split(',').map(e => e.trim()).filter(Boolean)
          : [],
      }));
    if (active.length > 0) return active;
  } catch (err) {
    console.warn('[scheduler] 3D_Teams sheet not found — using fallback single calendar:', err.message);
  }
  return [{
    Team_ID: 'TEAM-A', Team_Name: 'Team A',
    Calendar_ID: FALLBACK_CALENDAR_ID,
    Primary_Zones: [], Technician_Emails: [],
  }];
}

// ─── Postal Zone Lookup (unchanged) ──────────────────────────────────────────

export async function getZoneFromPostal(postalCode) {
  const sector = String(postalCode).trim().substring(0, 2).padStart(2, '0');
  const zones = await getPostalZones();
  for (const zone of zones) {
    const prefixes = parseSectorPrefixes(zone.Sector_Prefixes || zone.Sector_Prefix || '');
    if (prefixes.includes(sector)) return zone;
  }
  return null;
}

function parseSectorPrefixes(raw) {
  const prefixes = [];
  const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(s => parseInt(s.trim(), 10));
      for (let i = start; i <= end; i++) prefixes.push(String(i).padStart(2, '0'));
    } else {
      prefixes.push(part.trim().padStart(2, '0'));
    }
  }
  return prefixes;
}

// ─── Service Duration Lookup (unchanged) ─────────────────────────────────────

function normaliseServiceType(serviceType) {
  const upper = serviceType.toUpperCase().replace(/[^A-Z]/g, '');
  if (upper === 'GC') return 'G.C (mins)';
  if (upper === 'CW') return 'C.W (mins)';
  if (upper === 'CO') return 'C.O (mins)';
  if (upper === 'INSTALLATION' || upper === 'INSTALL') return 'Installation (mins)';
  if (serviceType.includes('G.C')) return 'G.C (mins)';
  if (serviceType.includes('C.W')) return 'C.W (mins)';
  if (serviceType.includes('C.O')) return 'C.O (mins)';
  if (serviceType.toLowerCase().includes('install')) return 'Installation (mins)';
  return serviceType;
}

export function serviceTypeLabel(serviceType) {
  const upper = serviceType.toUpperCase().replace(/[^A-Z]/g, '');
  if (upper === 'GC' || serviceType.includes('G.C')) return 'G.C';
  if (upper === 'CW' || serviceType.includes('C.W')) return 'C.W';
  if (upper === 'CO' || serviceType.includes('C.O')) return 'C.O';
  return 'Installation';
}

export async function getDurationMins(serviceType, units) {
  const unitNum = parseInt(units, 10);
  const colKey = normaliseServiceType(serviceType);
  const durations = await getServiceDurations();
  const row = durations.find(d => parseInt(d.Units, 10) === unitNum);
  if (row && row[colKey] !== undefined && row[colKey] !== '') return parseInt(row[colKey], 10);
  return getFallbackDuration(serviceType, unitNum);
}

function getFallbackDuration(serviceType, units) {
  const upper = serviceType.toUpperCase().replace(/[^A-Z]/g, '');
  const table = {
    GC: [15, 30, 45, 60, 75],
    CW: [30, 60, 90, 120, 150],
    CO: [90, 180, 270, 360, 450],
    INSTALLATION: [240, 285, 330, 375, 420],
    INSTALL: [240, 285, 330, 375, 420],
  };
  const row = table[upper];
  if (!row) throw new Error(`Unknown service type: ${serviceType}`);
  return row[Math.min(Math.max(units, 1), 5) - 1];
}

// ─── Time Helpers (unchanged) ──────────────────────────────────────────

const GRID_MINS = 15;

export function parseHHMM(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

export function formatHHMM(mins) {
  if (mins === null || mins === undefined || isNaN(mins)) return '';
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function format12h(mins) {
  if (mins === null || mins === undefined || isNaN(mins)) return '';
  const h24 = Math.floor(mins / 60), m = mins % 60;
  const period = h24 >= 12 ? 'pm' : 'am';
  let h12 = h24 % 12; if (h12 === 0) h12 = 12;
  return `${h12}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`}${period}`;
}

function roundUpToGrid(mins) { return Math.ceil(mins / GRID_MINS) * GRID_MINS; }

// ─── Slot Placement (unchanged) ──────────────────────────────────────────────

export function placeWindowInBlock(slot, serviceMins, blockMins, requestedStartHHMM) {
  const blockStart = parseHHMM(slot.Block_Start);
  const blockEnd = parseHHMM(slot.Block_End);
  if (blockStart === null || blockEnd === null)
    return { ok: false, reason: `Invalid block times: ${slot.Block_Start}–${slot.Block_End}` };

  const blockTotal = parseInt(slot.Block_Mins || '0', 10) || (blockEnd - blockStart);
  const minsRemaining = parseInt(slot.Mins_Remaining || '0', 10);
  const minsUsed = Math.max(0, blockTotal - minsRemaining);
  const earliestFreeStart = blockStart + minsUsed;

  let startMins;
  if (requestedStartHHMM) {
    const req = parseHHMM(requestedStartHHMM);
    if (req === null)
      return { ok: false, reason: `Couldn't parse time "${requestedStartHHMM}". Use HH:MM.` };
    startMins = roundUpToGrid(req);
  } else {
    startMins = roundUpToGrid(earliestFreeStart);
  }

  const reservedEnd = startMins + blockMins;
  const visibleEnd = startMins + serviceMins;

  if (startMins < blockStart)
    return { ok: false, reason: `Start ${formatHHMM(startMins)} is before block start.`, suggest: formatHHMM(earliestFreeStart) };
  if (reservedEnd > blockEnd)
    return { ok: false, reason: `Runs past block end ${formatHHMM(blockEnd)}.`, suggest: formatHHMM(Math.max(blockStart, blockEnd - blockMins)) };
  if (requestedStartHHMM && startMins < earliestFreeStart)
    return { ok: false, reason: `Conflicts with earlier booking. Earliest free: ${formatHHMM(earliestFreeStart)}.`, suggest: formatHHMM(earliestFreeStart) };
  if (minsRemaining < blockMins)
    return { ok: false, reason: `Only ${minsRemaining} mins remaining, need ${blockMins}.` };

  return { ok: true, placedStartMins: startMins, placedEndMins: visibleEnd, placedReservedEndMins: reservedEnd };
}

// ─── Multi-team + Zone-overflow Slot Finder ──────────────────────────────────

export async function findAvailableSlots(zoneId, durationMins, count = 3, assignedTeamId = '', preloadedRawTeams = null) {
  // Build WORK_BLOCKS and operating constants from 9_Settings (live, per-call).
  // Fallback values match original hardcoded defaults.
  const settings = await getSettings();
  const daysAhead = parseInt(settings.Days_Ahead ?? '14', 10);
  const hhmmSafe = (s, fallbackMins) => {
    const [h, m] = (s || '').trim().split(':').map(Number);
    const result = (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
    return (result > 0 && result <= 1440) ? result : fallbackMins;
  };
  const workBlocks = [
    { name: 'AM', start: hhmmSafe(settings.Work_Block_AM_Start, 540),  end: hhmmSafe(settings.Work_Block_AM_End,  720) },
    { name: 'PM', start: hhmmSafe(settings.Work_Block_PM_Start, 780), end: hhmmSafe(settings.Work_Block_PM_End, 1080) },
  ];

  // Flag jobs that exceed the largest single block
  const maxBlockMins = Math.max(...workBlocks.map(b => b.end - b.start));
  if (durationMins > maxBlockMins) {
    return [{
      _operatorFlag: true,
      _reason: 'exceeds_block',
      _durationMins: durationMins,
      _message:
        `This job needs ${durationMins} mins which exceeds the largest available block ` +
        `(${maxBlockMins} mins). Please create a calendar event manually and use /checkCal.`,
      Date: '', Day: '', Block: 'FULL_DAY',
      Block_Start: '09:00', Block_End: '18:00',
      Block_Mins: '0', Mins_Remaining: '0',
      Primary_Zone: zoneId, Status: 'operator_required',
    }];
  }

  // Load in-memory staged slots to prevent double-booking
  // during Google Calendar freebusy propagation delay (~30s)
  let stagedSlots = new Set();
  try {
    const { getStagedSlots } = await import('./bot.js');
    stagedSlots = getStagedSlots();
  } catch (e) {
    console.warn('[scheduler] getStagedSlots unavailable:', e.message);
  }

  const allTeams = await getTeamCalendars(preloadedRawTeams);
  const allJobs = await getJobs();
  const today = new Date();
  const slots = [];

  // Single forward walk: for each date, ask which teams cover this zone today.
  // getTeamsForZoneOnDate() handles both primary-day and overflow-day candidacy
  // per team, and assigns the correct buffer type per team.
  for (let d = 1; d < daysAhead && slots.length < count; d++) {
    const date = new Date(today); date.setDate(today.getDate() + d);
    const dateStr = fmtDate(date);
    const dayOfWeek = date.getDay();
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dayOfWeek];

    if (dayOfWeek === 0) continue; // Sunday closed

    const candidates = await getTeamsForZoneOnDate(zoneId, date, allTeams);
    if (candidates.length === 0) continue;

    // Repeat customer: filter to their assigned team if it's a candidate for this zone/date.
    // New customer (or assigned team not available): use all candidates.
    let filteredCandidates = candidates;
    if (assignedTeamId) {
      const assignedEntry = candidates.find(e => e.team.Team_ID === assignedTeamId);
      if (assignedEntry) filteredCandidates = [assignedEntry];
    }

    await tryAddSlotsForDay({
      dateStr, dayName, dayOfWeek, zoneId,
      teamEntries: filteredCandidates,
      stagedSlots, durationMins, slots, count, allJobs,
      workBlocks,
    });
  }

  return slots.slice(0, count);
}

/**
 * Tries to find and push slots for a single day across candidate teams.
 * teamEntries: [{ team, bufferMins, isOverflow, pmOnly }]
 *   - Each entry carries its own buffer and block restriction, so TEAM-A can
 *     work a zone as primary (AM+PM, 30-min buffer) while TEAM-B works the
 *     same zone on the same day as overflow (PM-only, 45-min buffer).
 * Mutates `slots` array in place.
 */
async function tryAddSlotsForDay({
  dateStr, dayName, dayOfWeek, zoneId,
  teamEntries,
  stagedSlots, durationMins, slots, count, allJobs,
  workBlocks,
}) {
  const dayStart = new Date(`${dateStr}T00:00:00+08:00`);
  const dayEnd = new Date(`${dateStr}T23:59:59+08:00`);

  // Fetch freebusy for all candidate teams in parallel (deduplicated by Team_ID)
  const busyByTeamId = {};
  await Promise.all(
    teamEntries.map(async ({ team }) => {
      if (busyByTeamId[team.Team_ID] !== undefined) return; // already fetched
      try {
        const busyTimes = await getBusyIntervals(team.Calendar_ID, dayStart.toISOString(), dayEnd.toISOString());
        busyByTeamId[team.Team_ID] = busyTimes.map(b => ({ start: toSGTMins(b.start), end: toSGTMins(b.end) }));
      } catch (err) {
        console.error(`[scheduler] freebusy FAILED for ${team.Team_ID} on ${dateStr} — excluding team from comparison:`, err.message);
        busyByTeamId[team.Team_ID] = null; // null → if (!busyMins) continue; will skip this team entirely
      }
    })
  );

  for (const block of workBlocks) {
    if (slots.length >= count) break;

    const slotKey = dateStr + '|' + block.name;
    if (stagedSlots.has(slotKey)) {
      console.log('[scheduler] Skipping ' + slotKey + ' — already staged');
      continue;
    }

    // Evaluate ALL candidate teams for this block; collect valid placements.
    const placements = [];
    for (const { team, bufferMins, isOverflow, pmOnly } of teamEntries) {
      // Overflow candidates are PM-only; skip AM block for them
      if (pmOnly && block.name !== 'PM') continue;

      const busyMins = busyByTeamId[team.Team_ID];
      if (!busyMins) continue;

      const gaps = findGapsInBlock(block.start, block.end, busyMins);
      const freeInBlock = gaps.reduce((s, g) => s + (g.end - g.start), 0);
      const blockBusyCount = busyMins.filter(b => b.start < block.end && b.end > block.start).length;

      let displayGaps, placedStart, placedEnd, reservedEnd;

      if (blockBusyCount === 0) {
        displayGaps = [{ start: block.start, end: block.end }];
        placedStart = roundUpToGrid(block.start);
        placedEnd = placedStart + durationMins;
        reservedEnd = placedEnd + bufferMins;
      } else {
        const qualifyingGaps = gaps.filter(g => (g.end - g.start) >= durationMins + bufferMins);
        if (qualifyingGaps.length === 0) continue;
        displayGaps = qualifyingGaps.map(g => ({ start: g.start, end: g.end }));
        const earliest = qualifyingGaps[0];
        placedStart = roundUpToGrid(earliest.start);
        placedEnd = placedStart + durationMins;
        reservedEnd = placedEnd + bufferMins;
        if (reservedEnd > earliest.end) continue;
      }

      placements.push({ team, bufferMins, isOverflow, freeInBlock, displayGaps, placedStart, placedEnd, reservedEnd });
    }

    if (placements.length === 0) continue;

    // Select best placement: earliest placedStart wins.
    // On tie: (a) fewest jobs this calendar week, (b) fewest jobs today, (c) random.
    let best = placements[0];
    if (placements.length > 1) {
      placements.sort((a, b) => a.placedStart - b.placedStart);
      const earliest = placements[0].placedStart;
      const tied = placements.filter(p => p.placedStart === earliest);

      if (tied.length === 1) {
        best = tied[0];
      } else {
        // Fetch job counts for all tied teams in parallel (lazy — only when tie exists)
        const tiedWithCounts = await Promise.all(tied.map(async p => ({
          ...p,
          counts: await getTeamWeeklyJobCount(p.team.Team_ID, dateStr, allJobs),
        })));
        const minWeek = Math.min(...tiedWithCounts.map(t => t.counts.week));
        const weekFiltered = tiedWithCounts.filter(t => t.counts.week === minWeek);

        if (weekFiltered.length === 1) {
          best = weekFiltered[0];
        } else {
          const minToday = Math.min(...weekFiltered.map(t => t.counts.today));
          const todayFiltered = weekFiltered.filter(t => t.counts.today === minToday);
          // Random tiebreak among remaining equals
          best = todayFiltered[Math.floor(Math.random() * todayFiltered.length)];
        }
      }
    }

    slots.push({
      Date: dateStr, Day: dayName, Block: block.name,
      Block_Start: formatHHMM(block.start), Block_End: formatHHMM(block.end),
      Block_Mins: String(block.end - block.start),
      Mins_Remaining: String(best.freeInBlock),
      Primary_Zone: zoneId, Zone_Name: zoneId,
      Status: best.freeInBlock === (block.end - block.start) ? 'available' : 'partially_booked',
      placedStartMins: best.placedStart,
      placedEndMins: best.placedEnd,
      placedReservedEndMins: best.reservedEnd,
      splitBlock: null,
      displayGaps: best.displayGaps,
      isOverflow: best.isOverflow,
      travelBufferMins: best.bufferMins,
      Team_ID: best.team.Team_ID,
      Team_Name: best.team.Team_Name,
      Calendar_ID: best.team.Calendar_ID,
    });
  }
}

/**
 * Returns { week: number, today: number } — job counts for a team on a given booking date.
 * week = total Job_ID rows in 2_Jobs for this team in the Mon-Sun week containing dateStr.
 * today = rows where Job_Date === dateStr (the specific booking date, not literal today).
 */
async function getTeamWeeklyJobCount(teamId, dateStr, allJobs = null) {
  const jobs = allJobs ?? await getJobs();
  // Compute Monday of the week containing dateStr (SGT)
  const d = new Date(dateStr + 'T00:00:00+08:00');
  const dow = d.getDay(); // 0=Sun
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const monDate = new Date(d); monDate.setDate(d.getDate() - daysFromMon);
  const sunDate = new Date(monDate); sunDate.setDate(monDate.getDate() + 7);
  const fmtMonDate = fmtDate(monDate);
  const fmtSunDate = fmtDate(sunDate); // exclusive upper bound

  let week = 0, today = 0;
  for (const job of jobs) {
    if ((job.Team_ID || '').trim() !== teamId) continue;
    const jd = (job.Job_Date || '').trim();
    if (jd >= fmtMonDate && jd < fmtSunDate) week++;
    if (jd === dateStr) today++;
  }
  return { week, today };
}
// ─── Helpers ──────────────────────────────────────────────────────────────────

function findGapsInBlock(blockStart, blockEnd, busyMins) {
  const blockBusy = busyMins
    .filter(b => b.start < blockEnd && b.end > blockStart)
    .map(b => ({ start: Math.max(b.start, blockStart), end: Math.min(b.end, blockEnd) }))
    .sort((a, b) => a.start - b.start);

  const gaps = [];
  let cursor = blockStart;
  for (const busy of blockBusy) {
    if (busy.start > cursor) gaps.push({ start: cursor, end: busy.start });
    cursor = Math.max(cursor, busy.end);
  }
  if (cursor < blockEnd) gaps.push({ start: cursor, end: blockEnd });
  return gaps.filter(g => g.end - g.start >= 15);
}

function toSGTMins(isoStr) {
  const d = new Date(isoStr);
  const sgtMs = d.getTime() + 8 * 60 * 60 * 1000;
  const sgtDate = new Date(sgtMs);
  return sgtDate.getUTCHours() * 60 + sgtDate.getUTCMinutes();
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── Slot Formatter (shows actual available gap, not full block) ────────────

export function formatSlotOptions(slots) {
  if (!slots || slots.length === 0) {
    return "Sorry, we don't have available slots in your area right now. We'll check our schedule and get back to you! 😊";
  }

  if (slots[0]?._operatorFlag) {
    return slots[0]._message;
  }

  const lines = ['Here are the available appointment slots for you:'];

  slots.forEach((slot, i) => {
    const date = slot.Date || 'TBD';
    const day = slot.Day || '';
    let timeTxt;

    if (slot.displayGaps && slot.displayGaps.length > 0) {
      const gapTxt = slot.displayGaps.map(g => format12h(g.start) + '–' + format12h(g.end)).join(', ');
      timeTxt = slot.Block + ' (' + gapTxt + ')';
    } else {
      const startMins = parseHHMM(slot.Block_Start);
      const endMins = parseHHMM(slot.Block_End);
      const startTxt = startMins !== null ? format12h(startMins) : slot.Block_Start;
      const endTxt = endMins !== null ? format12h(endMins) : slot.Block_End;
      timeTxt = slot.Block + ' (' + startTxt + '–' + endTxt + ')';
    }

    lines.push(`${i + 1}. ${day}, ${date} — ${timeTxt}`);
  });

  lines.push('\nReply with the option number (1, 2, or 3) to confirm.');
  lines.push("If you'd prefer a specific time within the slot, just let us know!");

  return lines.join('\n');
}
