const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// CONFIGURATION — edit these values
// ─────────────────────────────────────────────

// The exact name of the WhatsApp group to monitor
const GROUP_NAME = "🏆RM EU 275/1500 WEEKGOAL🏆";

// Schedule: send summary every 30 minutes between 10:00 and 21:00, every day
const SCHEDULE = "*/30 10-21 * * *";

// Timezone for the schedule
const TIMEZONE = "Europe/Amsterdam";

// Daily total target (shown in the grand total line)
const DAILY_TARGET = 250;

// ─────────────────────────────────────────────
// BOT LOGIC — no need to edit below this line
// ─────────────────────────────────────────────

// Medal emojis for ranking positions
const MEDALS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// Load recruiters.json — reloaded on every summary so changes take effect without restart
function loadRecruiters() {
  const filePath = path.join(__dirname, "data/recruiters.json");
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);

    // Build lookup maps for phone, lid, name and displayName
    const lookup = {};       // phone      → recruiter
    const lidLookup = {};    // lid        → recruiter
    const nameLookup = {};   // name       → recruiter (fallback)
    const displayLookup = {}; // displayName → recruiter (fallback)

    for (const [teamName, teamData] of Object.entries(data.teams)) {
      for (const member of teamData.members) {
        const entry = { name: member.name, team: teamName };
        if (member.phone)       lookup[member.phone]                       = entry;
        if (member.lid)         lidLookup[member.lid]                      = entry;
        if (member.name)        nameLookup[member.name.toLowerCase()]      = entry;
        if (member.displayName) displayLookup[member.displayName.toLowerCase()] = entry;
      }
    }
    return { teams: data.teams, lookup, lidLookup, nameLookup, displayLookup };
  } catch (err) {
    console.error("❌ Could not load recruiters.json:", err.message);
    return { teams: {}, lookup: {}, lidLookup: {}, nameLookup: {}, displayLookup: {} };
  }
}

// Automatically saves a discovered LID back into recruiters.json
function saveLidToJson(lid, name) {
  const filePath = path.join(__dirname, "data/recruiters.json");
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    for (const teamData of Object.values(data.teams)) {
      const member = teamData.members.find(
        (m) => m.name.toLowerCase() === name.toLowerCase()
      );
      if (member && !member.lid) {
        member.lid = lid;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
        console.log(`💾 Saved LID ${lid} for ${name} in recruiters.json`);
        return;
      }
    }
  } catch (err) {
    console.error("❌ Could not save LID to recruiters.json:", err.message);
  }
}

// Stores the latest reported total per phone: { "31612345678": { name, team, score } }
const recruiterTotals = {};

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "bot-1",
    dataPath: "./sessions"
  }),
  puppeteer: { 
    executablePath: '/usr/bin/chromium-browser', 
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
});

// Show QR code to link the WhatsApp number
client.on("qr", (qr) => {
  console.log("📱 Scan this QR code with your spare WhatsApp number:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  const { lookup } = loadRecruiters();
  console.log("✅ Bot is ready and listening!");
  console.log(`📅 Summary scheduled: ${SCHEDULE} (${TIMEZONE})`);
  console.log(`👥 Loaded ${Object.keys(lookup).length} recruiters from recruiters.json`);

  // Catch up on any messages missed while the bot was offline (e.g. laptop sleep)
  console.log("🔍 Scanning today's missed messages...");
  try {
    const chats = await client.getChats();
    const group = chats.find((c) => c.name === GROUP_NAME);
    if (!group) return;

    const messages = await group.fetchMessages({ limit: 100 });

    const todayStart = new Date();

    let caught = 0;
    for (const msg of messages) {
      const msgDate = new Date(msg.timestamp * 1000);

      if (msgDate.getDate() !== todayStart.getDate()) continue;

      const text = msg.body.trim();
      const match = text.match(/^\+?\s*(\d+)\s*\/\s*(\d+)/);
      if (!match) continue;

      const rawId = (msg.author || msg.from).replace(/@c\.us|@lid/g, "");
      const total = parseInt(match[2]);

      const contact = await msg.getContact();
      const displayName = contact.pushname || contact.name || rawId;

      const { lookup, lidLookup, nameLookup, displayLookup } = loadRecruiters();
      const recruiter =
        lookup[rawId] ||
        lidLookup[rawId] ||
        nameLookup[displayName.toLowerCase()] ||
        displayLookup[displayName.toLowerCase()];

      if (recruiter) {
        const prevScore = recruiterTotals[rawId]?.score ?? 0;
        const newScore = Math.max(prevScore, total);
        recruiterTotals[rawId] = { name: recruiter.name, team: recruiter.team, score: newScore };
        caught++;
      }
    }

    console.log(`✅ Caught up on ${caught} missed message(s) from today.`);
  } catch (err) {
    console.error("❌ Error scanning missed messages:", err.message);
  }
});

// Listen for messages in the group
client.on("message", async (msg) => {
  // Only process group messages
  if (!msg.from.endsWith("@g.us")) return;

  // Check it's the right group
  const chat = await msg.getChat();
  if (chat.name !== GROUP_NAME) return;

  const rawId = (msg.author || msg.from).replace(/@c\.us|@lid/g, "");
  const text = msg.body.trim();

  // Match patterns like: +1/10 | +3/15 | +1 / 10 | +2/8
  const match = text.match(/^\+?\s*(\d+)\s*\/\s*(\d+)/);
  if (!match) return;

  const added = parseInt(match[1]);
  const total = parseInt(match[2]);

  // Get contact display name
  const contact = await msg.getContact();
  const displayName = contact.pushname || contact.name || rawId;

  // Look up recruiter — try phone, LID, name, displayName in order
  const { lookup, lidLookup, nameLookup, displayLookup } = loadRecruiters();
  const recruiter =
    lookup[rawId] ||
    lidLookup[rawId] ||
    nameLookup[displayName.toLowerCase()] ||
    displayLookup[displayName.toLowerCase()];

  if (recruiter) {
    recruiterTotals[rawId] = { name: recruiter.name, team: recruiter.team, score: total };
    console.log(`📌 ${recruiter.name} (${rawId}) [${recruiter.team}] planned +${added} | total: ${total}`);

    // If this is a LID we haven't stored yet, save it back into recruiters.json
    if (rawId.length > 15 && !lookup[rawId] && !lidLookup[rawId]) {
      saveLidToJson(rawId, recruiter.name);
    }
  } else {
    // Still track unknown people, just without a team
    recruiterTotals[rawId] = { name: displayName, team: null, score: total };
    console.log(`⚠️  Unknown: ${rawId} (${displayName}) — add to recruiters.json to assign a team.`);
  }

  // React with a checkmark to confirm the message was logged
  // await msg.react("✅");
});

// Build and send the summary message
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

  const { teams } = loadRecruiters();

  let lines = [];
  lines.push("👑 *RECRUITER SCORE MESSAGE* 👑");
  lines.push("");

  let grandTotal = 0;
  let grandCount = 0;

  // Loop through teams in order from recruiters.json
  for (const [teamName, teamData] of Object.entries(teams)) {
    // Get scores for this team's members — check phone, lid, and name as keys
    const scores = teamData.members
      .map((m) => {
        // Find this member's entry in recruiterTotals by any of their known IDs
        const entry =
          (m.phone && recruiterTotals[m.phone]) ||
          (m.lid   && recruiterTotals[m.lid])   ||
          recruiterTotals[Object.keys(recruiterTotals).find(
            (k) => recruiterTotals[k].name.toLowerCase() === m.name.toLowerCase()
          )];
        return entry ? { name: entry.name, score: entry.score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (scores.length === 0) continue;

    const teamTotal = scores.reduce((sum, r) => sum + r.score, 0);
    const teamAvg = Math.round(teamTotal / scores.length);

    grandTotal += teamTotal;
    grandCount += scores.length;

    lines.push(`*${teamName}*`);
    scores.forEach(({ name, score }, i) => {
      const medal = MEDALS[i] || `${i + 1}.`;
      lines.push(`${medal} ${name} - ${score}`);
    });
    lines.push(`• Total: ${teamTotal}`);
    lines.push(`• AVG: ${teamAvg}`);
    lines.push("");
  }

  // Add anyone not assigned to a team at the bottom
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

  const grandAvg = grandCount > 0 ? Math.round(grandTotal / grandCount) : 0;

  lines.push(`🔥🚨 *TOTAL: ${grandTotal} /${DAILY_TARGET}*🚨🔥`);
  lines.push(`*GENERAL AVG: ${grandAvg}*`);

  const message = lines.join("\n");
  await group.sendMessage(message);
  console.log("📤 Summary sent!\n" + message);
}

// Schedule the summary
cron.schedule(
  SCHEDULE,
  () => {
    console.log("⏰ Scheduled summary triggered...");
    sendSummary();
  },
  { timezone: TIMEZONE }
);

// Reset all totals at midnight every day
cron.schedule(
  "0 0 * * *",
  () => {
    Object.keys(recruiterTotals).forEach((k) => delete recruiterTotals[k]);
    console.log("🔄 Midnight reset — all totals cleared for the new day.");
  },
  { timezone: TIMEZONE }
);

// Terminal commands while the bot is running:
//   send   → triggers the summary immediately
//   reset  → clears all recorded totals
//   status → prints current totals to the console
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (input) => {
  const cmd = input.trim().toLowerCase();
  if (cmd === "send") {
    console.log("🖐 Manual summary triggered...");
    sendSummary();
  }
  if (cmd === "reset") {
    Object.keys(recruiterTotals).forEach((k) => delete recruiterTotals[k]);
    console.log("🔄 Totals reset.");
  }
  if (cmd === "status") {
    console.log("📋 Current totals:", recruiterTotals);
  }
});

client.initialize();