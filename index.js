const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const { loadRecruiters } = require('./helpers/loadRecruiters');

// ─────────────────────────────────────────────
// CONFIGURATION — edit these values
// ─────────────────────────────────────────────

const GROUP_NAME = "🏆RM EU 275/1500 WEEKGOAL🏆";
const SCHEDULE = "*/30 10-21 * * *";
const TIMEZONE = "Europe/Amsterdam";
const DAILY_TARGET = 250;

// How many recent group messages to re-read before each summary, to pick up scores
// that were posted while the bot was not listening.
const CATCH_UP_LIMIT = 300;

const HEALTH_CHECK_INTERVAL = 2 * 60 * 1000;
const HEALTH_MAX_FAILURES = 3;             // ~6 minutes broken before we restart
const PAGE_TIMEOUT = 60 * 1000;            // a single call into the WhatsApp Web page
const REINJECT_GRACE = 3 * 60 * 1000;      // time whatsapp-web.js gets to re-inject after a reload
const SUMMARY_TIMEOUT = 5 * 60 * 1000;

const SCORE_PATTERN = /^(?:([a-z\s]+):\s*)?\+?\s*(\d+)\s*\/\s*(\d+)/;

// ─────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────

const TOTALS_FILE = path.join(__dirname, "data/recruiterTotals.json");

// Bookkeeping saved next to the scores, under "_"-prefixed keys so it survives a restart.
const state = {
  since: 0,              // messages before this timestamp (ms) are ignored — set by the "reset" command
  lastSentTotal: 0,      // grand total of the last summary that went out
  pendingSummary: false, // a summary failed and should be sent as soon as we are back up
};

function dayKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

function loadTotals() {
  try {
    if (!fs.existsSync(TOTALS_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(TOTALS_FILE, "utf8"));
    // Only restore if saved today
    if (data._date !== dayKey()) {
      console.log("📅 Saved totals are from a previous day, starting fresh.");
      return {};
    }
    state.since = data._since ?? 0;
    state.lastSentTotal = data._lastSentTotal ?? 0;
    state.pendingSummary = data._pendingSummary ?? false;
    for (const key of Object.keys(data)) {
      if (key.startsWith("_")) delete data[key];
    }
    console.log(`💾 Restored ${Object.keys(data).length} scores from disk.`);
    return data;
  } catch (err) {
    console.error("❌ Could not load recruiterTotals.json:", err.message);
    return {};
  }
}

function saveTotals() {
  try {
    const data = {
      ...recruiterTotals,
      _date: dayKey(),
      _since: state.since,
      _lastSentTotal: state.lastSentTotal,
      _pendingSummary: state.pendingSummary,
    };
    fs.mkdirSync(path.dirname(TOTALS_FILE), { recursive: true });
    fs.writeFileSync(TOTALS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("❌ Could not save recruiterTotals.json:", err.message);
  }
}

function clearTotals() {
  Object.keys(recruiterTotals).forEach((k) => delete recruiterTotals[k]);
  state.lastSentTotal = 0;
}

// ─────────────────────────────────────────────
// BOT LOGIC
// ─────────────────────────────────────────────

const MEDALS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// Load persisted totals on startup
const recruiterTotals = loadTotals();

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "recruitment-bot",
    dataPath: "./sessions-recruitment"
  }),
  puppeteer: {
    // The Chrome puppeteer downloads has no Linux ARM build, so the ARM server needs the
    // system Chromium from snap. Hold its refreshes (`snap refresh --hold=forever chromium`):
    // a snap refresh kills the running browser. Set CHROME_PATH to use another browser.
    executablePath: process.env.CHROME_PATH || (process.arch === "arm64" ? "/snap/bin/chromium" : undefined),
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
});

client.on("qr", (qr) => {
  console.log("📱 Scan this QR code with your spare WhatsApp number:\n");
  qrcode.generate(qr, { small: true });
});

// Also fires again every time whatsapp-web.js re-injects after WhatsApp Web reloaded itself.
client.on("ready", async () => {
  const { lookup } = await loadRecruiters();
  console.log("✅ Bot is ready and listening!");
  console.log(`📅 Summary scheduled: ${SCHEDULE} (${TIMEZONE})`);
  console.log(`👥 Loaded ${Object.keys(lookup).length} recruiters`);
  console.log(`📊 Restored ${Object.keys(recruiterTotals).length} scores from previous session.`);

  startHealthCheck();

  try {
    const group = await findGroup();
    if (group) await catchUpMessages(group);
  } catch (err) {
    console.error("❌ Inhaalslag na opstarten mislukt:", err?.message || err);
  }

  if (state.pendingSummary) {
    console.log("📨 Vorige samenvatting was mislukt, nu alsnog versturen...");
    sendSummary();
  }
});

// ─────────────────────────────────────────────
// CONNECTION HEALTH
// ─────────────────────────────────────────────
//
// WhatsApp Web reloads its own tab whenever it ships an update. That reload wipes
// the helpers whatsapp-web.js injects into the page (window.Store / window.WWebJS):
// from then on no "message" events arrive and every call dies with "Cannot read
// properties of undefined (reading 'getChats')". whatsapp-web.js re-injects by itself
// once the reloaded page has synced, but when that fails the page stays broken until
// the process restarts. Calling client.inject() ourselves does not help: it only
// registers a listener and returns before anything is injected.
//
// So: give the library time to recover, and if it doesn't, exit and let pm2 start us
// with a fresh browser. Scores are on disk and the catch-up re-reads missed messages.

let healthTimer = null;
let failedChecks = 0;
let restarting = false;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} reageert niet binnen ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function isInjected() {
  const page = client.pupPage;
  if (!page || page.isClosed()) return false;
  return withTimeout(
    page.evaluate(() => typeof window.Store !== "undefined" && typeof window.WWebJS !== "undefined"),
    PAGE_TIMEOUT,
    "WhatsApp Web-pagina"
  );
}

async function waitUntilInjected() {
  if (await isInjected()) return;
  console.warn("⚠️ WhatsApp Web-pagina is herladen, wachten tot whatsapp-web.js opnieuw injecteert...");
  const deadline = Date.now() + REINJECT_GRACE;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    if (await isInjected()) {
      console.log("✅ Injectie hersteld.");
      return;
    }
  }
  throw new Error("WhatsApp Web-helpers nog steeds niet beschikbaar na herladen");
}

async function restart(reason) {
  if (restarting) return;
  restarting = true;
  console.error(`🔁 Proces herstarten (pm2) na: ${reason}`);
  saveTotals();
  try {
    await withTimeout(client.destroy(), 15000, "Browser afsluiten");
  } catch (err) {
    console.error("⚠️ Browser netjes afsluiten mislukt:", err?.message || err);
  }
  process.exit(1);
}

function startHealthCheck() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    let healthy = false;
    try {
      healthy = await isInjected();
    } catch (err) {
      console.error("⚠️ Health check fout:", err?.message || err);
    }
    if (healthy) {
      if (failedChecks > 0) console.log("✅ WhatsApp Web is weer bruikbaar.");
      failedChecks = 0;
      return;
    }
    failedChecks++;
    console.warn(`⚠️ WhatsApp Web niet bruikbaar (${failedChecks}/${HEALTH_MAX_FAILURES})`);
    if (failedChecks >= HEALTH_MAX_FAILURES) restart("WhatsApp Web bleef onbruikbaar");
  }, HEALTH_CHECK_INTERVAL);
}

client.on("disconnected", (reason) => {
  console.error(`🔌 Verbinding verbroken: ${reason}`);
  // whatsapp-web.js calls destroy() itself here, so only a full restart helps.
  process.exit(1);
});

client.on("auth_failure", (msg) => {
  console.error(`🔑 Authenticatie mislukt: ${msg} — QR opnieuw scannen is nodig.`);
});

process.on("unhandledRejection", (err) => {
  console.error("⚠️ Onafgehandelde fout:", err?.message || err);
});

// ─────────────────────────────────────────────
// SCORE MESSAGES
// ─────────────────────────────────────────────

const contactNames = new Map();
const reportedLids = new Set();

async function getDisplayName(msg, rawId) {
  if (!contactNames.has(rawId)) {
    const contact = await msg.getContact();
    contactNames.set(rawId, contact.pushname || contact.name || rawId);
  }
  return contactNames.get(rawId);
}

// Applies one group message to the totals. Scores only ever go up (the message carries
// the day total), so handling the same message twice is harmless — the catch-up relies
// on that. Returns true when a score changed.
async function processScoreMessage(msg, { live }) {
  const text = (msg.body || "").trim().toLowerCase();
  const match = text.match(SCORE_PATTERN);
  if (!match) {
    if (live && /\d+\s*\/\s*\d+/.test(text)) {
      console.warn(`⚠️ Score-bericht niet herkend (formaat): "${msg.body}"`);
    }
    return false;
  }

  const mentionedName = match[1]?.trim();
  const added = parseInt(match[2]);
  const total = parseInt(match[3]);

  const { lookup, lidLookup, nameLookup, displayLookup } = await loadRecruiters();
  const rawId = (msg.author || msg.from || "").replace(/@c\.us|@lid/g, "");

  let recruiter;
  let known = true;

  if (mentionedName) {
    recruiter = nameLookup[mentionedName] || displayLookup[mentionedName];
    if (!recruiter) {
      if (live) console.warn(`⚠️ Naam "${mentionedName}" staat niet in de sheet, score genegeerd: "${msg.body}"`);
      return false;
    }
  } else {
    if (!rawId) return false;
    recruiter = lookup[rawId] || lidLookup[rawId];
    if (!recruiter) {
      const displayName = await getDisplayName(msg, rawId);
      recruiter = nameLookup[displayName.toLowerCase()] || displayLookup[displayName.toLowerCase()];
      if (recruiter && rawId.length > 15 && !reportedLids.has(rawId)) {
        reportedLids.add(rawId);
        console.log(`💡 ${recruiter.name} stuurt vanaf LID ${rawId} — zet dit in de LID-kolom van de sheet.`);
      }
      if (!recruiter) {
        recruiter = { name: displayName, team: null };
        known = false;
      }
    }
  }

  // Known recruiters are keyed by name, so a score posted by someone else ("naam: +1/5")
  // and one they post themselves land on the same entry.
  const key = known ? recruiter.name.toLowerCase() : rawId;
  const prevScore = recruiterTotals[key]?.score ?? 0;
  let newScore = Math.max(prevScore, total);

  // Fold in entries for the same person stored under another key (phone, LID, older versions)
  for (const [otherKey, val] of Object.entries(recruiterTotals)) {
    if (otherKey !== key && val.name.toLowerCase() === recruiter.name.toLowerCase()) {
      newScore = Math.max(newScore, val.score);
      delete recruiterTotals[otherKey];
      console.log(`🔀 Merged duplicate entry for ${recruiter.name} (${otherKey} → ${key})`);
    }
  }

  const changed = !recruiterTotals[key] || newScore !== prevScore;
  recruiterTotals[key] = { name: recruiter.name, team: recruiter.team, score: newScore };

  if (live || changed) {
    const prefix = !known ? `⚠️ Onbekend: ${rawId}` : mentionedName ? "👤 (Via derde)" : "📌";
    const source = live ? "" : " (ingehaald)";
    console.log(`${prefix} ${recruiter.name} [${recruiter.team}] +${added} | totaal nu: ${newScore}${source}`);
  }
  return changed;
}

client.on("message", async (msg) => {
  if (!msg.from.endsWith("@g.us")) return;

  try {
    const chat = await msg.getChat();
    if (chat.name !== GROUP_NAME) return;
    if (await processScoreMessage(msg, { live: true })) saveTotals();
  } catch (err) {
    console.error("❌ Fout bij verwerken live bericht:", err.message);
  }
});

// Re-reads today's group messages so scores posted while the page was broken, or while
// the bot was restarting, still count.
async function catchUpMessages(group) {
  let messages;
  try {
    messages = await withTimeout(
      group.fetchMessages({ limit: CATCH_UP_LIMIT }),
      PAGE_TIMEOUT,
      "Berichten ophalen"
    );
  } catch (err) {
    // Loading older history goes through WhatsApp internals that change often. Without a
    // limit we only get what the page already holds, which is usually most of today.
    console.warn("⚠️ Oudere berichten laden mislukt, alleen geladen berichten gebruiken:", err?.message || err);
    messages = await withTimeout(group.fetchMessages({}), PAGE_TIMEOUT, "Berichten ophalen");
  }
  const today = dayKey();
  let updated = 0;

  for (const msg of messages) {
    if (msg.fromMe) continue;
    const sentAt = msg.timestamp * 1000;
    if (sentAt < state.since || dayKey(new Date(sentAt)) !== today) continue;
    try {
      if (await processScoreMessage(msg, { live: false })) updated++;
    } catch (err) {
      console.error("❌ Fout bij inhalen bericht:", err.message);
    }
  }

  if (updated > 0) {
    saveTotals();
    console.log(`🔄 Inhaalslag: ${updated} gemiste score(s) verwerkt.`);
  }
}

// ─────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────

async function findGroup() {
  const chats = await withTimeout(client.getChats(), PAGE_TIMEOUT, "Chats ophalen");
  const group = chats.find((c) => c.name === GROUP_NAME);
  if (!group) console.log(`❌ Group "${GROUP_NAME}" not found.`);
  return group;
}

let sending = false;

async function sendSummary() {
  if (sending || restarting) return;
  sending = true;
  try {
    await waitUntilInjected();
    await withTimeout(buildAndSendSummary(), SUMMARY_TIMEOUT, "Samenvatting");
    state.pendingSummary = false;
    saveTotals();
  } catch (err) {
    console.error("❌ Samenvatting versturen mislukt:", err?.message || err);
    state.pendingSummary = true;
    await restart("fout bij versturen samenvatting");
  } finally {
    sending = false;
  }
}

async function buildAndSendSummary() {
  const group = await findGroup();
  if (!group) return;

  try {
    await catchUpMessages(group);
  } catch (err) {
    // Not fatal: send what we have from the live messages.
    console.error("⚠️ Inhaalslag mislukt:", err?.message || err);
  }

  if (Object.keys(recruiterTotals).length === 0) {
    console.log("📭 No data to report yet.");
    return;
  }

  const { teams } = await loadRecruiters();

  let lines = [];
  lines.push("👑 *RECRUITER SCORE MESSAGE* 👑");
  lines.push("");

  let grandTotal = 0;
  let grandCount = 0;

  for (const [teamName, teamData] of Object.entries(teams)) {
    const scores = teamData.members
      .map((m) => {
        const entry =
          recruiterTotals[m.name.toLowerCase()] ||
          (m.phone && recruiterTotals[m.phone]) ||
          (m.lid   && recruiterTotals[m.lid])   ||
          recruiterTotals[Object.keys(recruiterTotals).find(
            (k) => recruiterTotals[k].name.toLowerCase() === m.name.toLowerCase()
          )];
        return entry ? { name: entry.name, score: entry.score, support: m.support } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (scores.length === 0) continue;

    const fullRecruiterLength = scores.filter(r => !r.support).length;
    const teamTotal = scores.reduce((sum, r) => r.support ? sum : sum + r.score, 0);
    const teamAvg = Math.round(teamTotal / fullRecruiterLength);
    const teamGrandTotal = scores.reduce((sum, r) => sum + r.score, 0);

    grandTotal += teamGrandTotal;
    grandCount += fullRecruiterLength;

    lines.push(`*${teamName}*`);
    scores.filter(r => !r.support).forEach(({ name, score }, i) => {
      const medal = MEDALS[i] || `${i + 1}.`;
      lines.push(`${medal} ${name} - ${score}`);
    });
    lines.push(`• Total: ${teamTotal}`);
    lines.push(`• AVG: ${teamAvg}`);
    lines.push("");

    if ((scores.length - fullRecruiterLength) > 0) {
      lines.push("Support:");
      scores.filter(r => r.support).forEach(({ name, score }) => {
        lines.push(`🔹 ${name} - ${score}`);
      });
      lines.push("");
      lines.push(`Total planned: ${teamGrandTotal}`);
      lines.push("");
    }
  }

  const unassigned = Object.values(recruiterTotals)
    .filter((r) => r.team === null)
    .sort((a, b) => b.score - a.score);

  if (unassigned.length > 0) {
    lines.push(`*❓ UNASSIGNED*`);
    unassigned.forEach(({ name, score }, i) => {
      const medal = MEDALS[i] || `${i + 1}.`;
      lines.push(`${medal} ${name} - ${score}`);
    });
    grandTotal += unassigned.reduce((sum, r) => sum + r.score, 0);
    grandCount += unassigned.length;
    lines.push("");
  }

  if (grandTotal === state.lastSentTotal) {
    console.log('No new updates since last summary, skipping.');
    return;
  }

  const grandAvg = grandCount > 0 ? Math.round(grandTotal / grandCount) : 0;

  lines.push(`🔥🚨 *TOTAL: ${grandTotal} /${DAILY_TARGET}*🚨🔥`);
  lines.push(`*GENERAL AVG: ${grandAvg}*`);

  const message = lines.join("\n");
  await group.sendMessage(message);
  // Only mark as reported once the message actually went out, otherwise a failed
  // send would make the next run think there is nothing new to report.
  state.lastSentTotal = grandTotal;
  console.log("📤 Summary sent!\n" + message);
}

cron.schedule(SCHEDULE, () => {
  const randomDelay = Math.floor(Math.random() * 60000);
  setTimeout(() => {
    console.log("⏰ Scheduled summary triggered...");
    sendSummary();
  }, randomDelay);
}, { timezone: TIMEZONE });

cron.schedule("0 0 * * *", () => {
  clearTotals();
  state.since = 0;
  state.pendingSummary = false;
  saveTotals();
  console.log("🔄 Midnight reset — all totals cleared for the new day.");
}, { timezone: TIMEZONE });

process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (input) => {
  const cmd = input.trim().toLowerCase();
  if (cmd === "send") { console.log("🖐 Manual summary triggered..."); sendSummary(); }
  if (cmd === "reset") {
    clearTotals();
    // Keep the catch-up from reading back messages sent before the reset
    state.since = Date.now();
    saveTotals();
    console.log("🔄 Totals reset.");
  }
  if (cmd === "status") { console.log("📋 Current totals:", recruiterTotals); }
});

// Without this a browser that fails to launch only logs an unhandled rejection, and the
// process lives on without WhatsApp while the cron jobs keep failing.
client.initialize().catch(async (err) => {
  console.error("❌ WhatsApp starten mislukt:", err?.message || err);
  // Pause so pm2 doesn't restart us in a tight loop while the browser stays broken.
  await new Promise((r) => setTimeout(r, 30000));
  process.exit(1);
});
