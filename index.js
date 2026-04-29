const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const { loadRecruiters, invalidateRecruiterCache } = require('./helpers/loadRecruiters');

// ─────────────────────────────────────────────
// CONFIGURATION — edit these values
// ─────────────────────────────────────────────

const GROUP_NAME = "🏆RM EU 275/1500 WEEKGOAL🏆";
const SCHEDULE = "*/30 10-21 * * *";
const TIMEZONE = "Europe/Amsterdam";
const DAILY_TARGET = 250;

// ─────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────

const TOTALS_FILE = path.join(__dirname, "data/recruiterTotals.json");

function loadTotals() {
  try {
    if (!fs.existsSync(TOTALS_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(TOTALS_FILE, "utf8"));
    // Only restore if saved today
    const savedDate = data._date;
    const today = new Date().toDateString();
    if (savedDate !== today) {
      console.log("📅 Saved totals are from a previous day, starting fresh.");
      return {};
    }
    delete data._date;
    console.log(`💾 Restored ${Object.keys(data).length} scores from disk.`);
    return data;
  } catch (err) {
    console.error("❌ Could not load recruiterTotals.json:", err.message);
    return {};
  }
}

function saveTotals() {
  try {
    const data = { ...recruiterTotals, _date: new Date().toDateString() };
    fs.mkdirSync(path.dirname(TOTALS_FILE), { recursive: true });
    fs.writeFileSync(TOTALS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("❌ Could not save recruiterTotals.json:", err.message);
  }
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
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
});

client.on("qr", (qr) => {
  console.log("📱 Scan this QR code with your spare WhatsApp number:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  const { lookup } = await loadRecruiters();
  console.log("✅ Bot is ready and listening!");
  console.log(`📅 Summary scheduled: ${SCHEDULE} (${TIMEZONE})`);
  console.log(`👥 Loaded ${Object.keys(lookup).length} recruiters`);
  console.log(`📊 Restored ${Object.keys(recruiterTotals).length} scores from previous session.`);
});

client.on("message", async (msg) => {
  if (!msg.from.endsWith("@g.us")) return;

  try {
    const chat = await msg.getChat();
    if (chat.name !== GROUP_NAME) return;

    const text = msg.body.trim().toLowerCase();
    const match = text.match(/^(?:([a-z\s]+):\s*)?\+?\s*(\d+)\s*\/\s*(\d+)/);
    if (!match) return;

    const mentionedName = match[1]?.trim();
    const added = parseInt(match[2]);
    const total = parseInt(match[3]);

    let targetRecruiter = null;
    let targetId = null;
    let isThirdParty = false;

    const { lookup, lidLookup, nameLookup, displayLookup } = await loadRecruiters();

    if (mentionedName) {
      targetRecruiter = nameLookup[mentionedName] || displayLookup[mentionedName];
      targetId = targetRecruiter ? (targetRecruiter.id || mentionedName) : null;
      isThirdParty = true;
    } else {
      const rawId = (msg.author || msg.from || "").replace(/@c\.us|@lid/g, "");
      if (!rawId) return;
      targetRecruiter = lookup[rawId] || lidLookup[rawId];
      if (!targetRecruiter) {
        const contact = await msg.getContact();
        const displayName = (contact.pushname || contact.name || "").toLowerCase();
        targetRecruiter = nameLookup[displayName] || displayLookup[displayName];
      }
      targetId = rawId;
    }

    if (targetRecruiter && targetId) {
      const prevScore = recruiterTotals[targetId]?.score ?? 0;
      const newScore = Math.max(prevScore, total);

      if (targetRecruiter && targetId) {
        const prevScore = recruiterTotals[targetId]?.score ?? 0;
        const newScore = Math.max(prevScore, total);

        // ── Dedup: verwijder eventuele andere entries voor dezelfde persoon ──
        for (const [key, val] of Object.entries(recruiterTotals)) {
          if (key !== targetId && val.name.toLowerCase() === targetRecruiter.name.toLowerCase()) {
            const existingScore = val.score;
            delete recruiterTotals[key];
            // Neem de hoogste score mee
            if (existingScore > newScore) newScore = existingScore;
            console.log(`🔀 Merged duplicate entry for ${targetRecruiter.name} (${key} → ${targetId})`);
          }
        }

        recruiterTotals[targetId] = { name: targetRecruiter.name, team: targetRecruiter.team, score: newScore };
        saveTotals();
      }

      const logPrefix = isThirdParty ? `👤 (Via derde) ${targetRecruiter.name}` : `📌 ${targetRecruiter.name}`;
      console.log(`${logPrefix} [${targetRecruiter.team}] +${added} | totaal nu: ${newScore}`);

      if (!isThirdParty && targetId.length > 15 && !lookup[targetId] && !lidLookup[targetId]) {
        saveLidToJson(targetId, targetRecruiter.name);
        invalidateRecruiterCache();
      }

      // Save to disk on every score update
      saveTotals();

    } else if (!isThirdParty) {
      const rawId = (msg.author || msg.from || "").replace(/@c\.us|@lid/g, "");
      const contact = await msg.getContact();
      const displayName = contact.pushname || contact.name || rawId;
      recruiterTotals[rawId] = { name: displayName, team: null, score: total };
      console.log(`⚠️ Onbekend: ${rawId} (${displayName}) stuurde score ${total}`);
      saveTotals();
    }

  } catch (err) {
    console.error("❌ Fout bij verwerken live bericht:", err.message);
  }
});

let oldGrandTotal = 0;

async function sendSummary() {
  const chats = await client.getChats();
  const group = chats.find((c) => c.name === GROUP_NAME);

  if (!group) {
    console.log(`❌ Group "${GROUP_NAME}" not found.`);
    return;
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

  if (grandTotal === oldGrandTotal) {
    console.log('No new updates since last summary, skipping.');
    return;
  } else {
    oldGrandTotal = grandTotal;
  }

  const grandAvg = grandCount > 0 ? Math.round(grandTotal / grandCount) : 0;

  lines.push(`🔥🚨 *TOTAL: ${grandTotal} /${DAILY_TARGET}*🚨🔥`);
  lines.push(`*GENERAL AVG: ${grandAvg}*`);

  const message = lines.join("\n");
  await group.sendMessage(message);
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
  Object.keys(recruiterTotals).forEach((k) => delete recruiterTotals[k]);
  // Clear persisted file at midnight
  try { fs.writeFileSync(TOTALS_FILE, JSON.stringify({ _date: new Date().toDateString() }, null, 2)); } catch (_) {}
  console.log("🔄 Midnight reset — all totals cleared for the new day.");
}, { timezone: TIMEZONE });

process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (input) => {
  const cmd = input.trim().toLowerCase();
  if (cmd === "send") { console.log("🖐 Manual summary triggered..."); sendSummary(); }
  if (cmd === "reset") { Object.keys(recruiterTotals).forEach((k) => delete recruiterTotals[k]); saveTotals(); console.log("🔄 Totals reset."); }
  if (cmd === "status") { console.log("📋 Current totals:", recruiterTotals); }
});

client.initialize();