const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// CONFIGURATION — edit these values
// ─────────────────────────────────────────────

// The exact name of the WhatsApp group to monitor
const GROUP_NAME = "🏆RM EU 275/1500 WEEKGOAL🏆"; //🏆RM EU 275/1500 WEEKGOAL🏆

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
    clientId: "recruitment-bot",
    dataPath: "./sessions-recruitment"
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

  console.log("🔍 Scanning today's missed messages (including third-party updates)...");
  try {
    const chats = await client.getChats();
    const group = chats.find((c) => c.name === GROUP_NAME);
    if (!group) return;

    const messages = await group.fetchMessages({ limit: 100 });
    const todayStart = new Date();
    let caught = 0;

    for (const msg of messages) {
      try { // Extra try-catch BINNEN de loop, zodat 1 fout niet alles stopt
          const msgDate = new Date(msg.timestamp * 1000);
          if (msgDate.getDate() !== todayStart.getDate()) continue;

          const text = msg.body.trim().toLowerCase();
          
          // De regex: (naam optioneel):(score)
          const match = text.match(/^(?:([a-z\s]+):\s*)?\+?\s*(\d+)\s*\/\s*(\d+)/);
          if (!match) continue;

          const mentionedName = match[1]?.trim();
          const total = parseInt(match[3]);

          let targetRecruiter = null;
          let targetId = null;

          const { lookup, lidLookup, nameLookup, displayLookup } = loadRecruiters();

          if (mentionedName) {
              // SCENARIO 1: "josi: +6/16"
              targetRecruiter = nameLookup[mentionedName] || displayLookup[mentionedName];
              // Gebruik het ID uit de JSON, of de naam als fallback (nooit undefined laten!)
              targetId = targetRecruiter ? (targetRecruiter.id || mentionedName) : null;
          } else {
              // SCENARIO 2: Eigen score "+6/16"
              const rawId = (msg.author || msg.from || "").replace(/@c\.us|@lid/g, "");
              if (!rawId) continue;

              targetRecruiter = lookup[rawId] || lidLookup[rawId];

              // Alleen als we hem nog niet hebben op ID, checken we de contactnaam
              if (!targetRecruiter) {
                  const contact = await msg.getContact();
                  if (contact && (contact.pushname || contact.name)) {
                      const displayName = (contact.pushname || contact.name).toLowerCase();
                      targetRecruiter = nameLookup[displayName] || displayLookup[displayName];
                  }
              }
              targetId = rawId;
          }

          if (targetRecruiter && targetId) {
              const prevScore = recruiterTotals[targetId]?.score ?? 0;
              const newScore = Math.max(prevScore, total);
              
              recruiterTotals[targetId] = { 
                  name: targetRecruiter.name, 
                  team: targetRecruiter.team, 
                  score: newScore 
              };
              caught++;
          }
      } catch (innerErr) {
          console.error("⚠️ Slaan een bericht over wegens fout:", innerErr.message);
          // We gaan gewoon door naar het volgende bericht in de loop
      }
    }

    console.log(`✅ Caught up on ${caught} missed message(s) from today.`);
    console.log("📋 Current totals:", recruiterTotals);
  } catch (err) {
    console.error("❌ Kritieke fout bij scannen:", err.message);
  }
});

// Listen for messages in the group
client.on("message", async (msg) => {
  // 1. Basic checks
  if (!msg.from.endsWith("@g.us")) return;
  
  try {
    const chat = await msg.getChat();
    if (chat.name !== GROUP_NAME) return;

    const text = msg.body.trim().toLowerCase();
    
    // Regex: (naam optioneel):(score) -> josi: +6/16 of +6/16
    const match = text.match(/^(?:([a-z\s]+):\s*)?\+?\s*(\d+)\s*\/\s*(\d+)/);
    if (!match) return;

    // Belangrijk: match[1] is de naam, match[2] is de '+6', match[3] is de '16'
    const mentionedName = match[1]?.trim();
    const added = parseInt(match[2]);
    const total = parseInt(match[3]);

    let targetRecruiter = null;
    let targetId = null;
    let isThirdParty = false;

    const { lookup, lidLookup, nameLookup, displayLookup } = loadRecruiters();

    if (mentionedName) {
      // SCENARIO 1: Iemand voert score in voor een ander ("josi: +6/16")
      targetRecruiter = nameLookup[mentionedName] || displayLookup[mentionedName];
      targetId = targetRecruiter ? (targetRecruiter.id || mentionedName) : null;
      isThirdParty = true;
    } else {
      // SCENARIO 2: Eigen score ("+6/16")
      const rawId = (msg.author || msg.from || "").replace(/@c\.us|@lid/g, "");
      if (!rawId) return;

      targetRecruiter = lookup[rawId] || lidLookup[rawId];

      // Fallback op displaynaam als ID niet in de lijst staat
      if (!targetRecruiter) {
        const contact = await msg.getContact();
        const displayName = (contact.pushname || contact.name || "").toLowerCase();
        targetRecruiter = nameLookup[displayName] || displayLookup[displayName];
      }
      targetId = rawId;
    }

    if (targetRecruiter && targetId) {
      // Update de scores in het geheugen
      const prevScore = recruiterTotals[targetId]?.score ?? 0;
      const newScore = Math.max(prevScore, total);

      recruiterTotals[targetId] = { 
        name: targetRecruiter.name, 
        team: targetRecruiter.team, 
        score: newScore 
      };

      const logPrefix = isThirdParty ? `👤 (Via derde) ${targetRecruiter.name}` : `📌 ${targetRecruiter.name}`;
      console.log(`${logPrefix} [${targetRecruiter.team}] +${added} | totaal nu: ${newScore}`);

      // Automatisch LID opslaan als het een eigen score is en nog niet bekend
      if (!isThirdParty && targetId.length > 15 && !lookup[targetId] && !lidLookup[targetId]) {
        saveLidToJson(targetId, targetRecruiter.name);
      }
      
      // Optioneel: vinkje geven
      // await msg.react("✅");

    } else if (!isThirdParty) {
      // Alleen onbekenden loggen als ze hun eigen score sturen (voorkomt spam bij typfouten in namen)
      const rawId = (msg.author || msg.from || "").replace(/@c\.us|@lid/g, "");
      const contact = await msg.getContact();
      const displayName = contact.pushname || contact.name || rawId;
      
      recruiterTotals[rawId] = { name: displayName, team: null, score: total };
      console.log(`⚠️ Onbekend: ${rawId} (${displayName}) stuurde score ${total}`);
    }

  } catch (err) {
    console.error("❌ Fout bij verwerken live bericht:", err.message);
  }
});

let oldGrandTotal = 0;

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

  if (grandTotal === oldGrandTotal) {
    console.log('No new updates since last summary, skipping message send.');
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

// Schedule the summary
cron.schedule(
  SCHEDULE,
  () => {
    const randomDelay = Math.floor(Math.random() * 60000);
    setTimeout(() => {
      console.log("⏰ Scheduled summary triggered...");
      sendSummary();
    }, randomDelay);
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