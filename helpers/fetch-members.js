const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

const GROUP_NAME = "🏆RM EU 275/1500 WEEKGOAL🏆";

// ─────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox"] },
});

client.on("qr", (qr) => {
  console.log("📱 Scan this QR code to connect:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("✅ Connected! Fetching group members...\n");

  const chats = await client.getChats();
  const group = chats.find((c) => c.name === GROUP_NAME);

  if (!group) {
    console.error(`❌ Group "${GROUP_NAME}" not found.`);
    process.exit(1);
  }

  console.log(`📋 Found group: "${GROUP_NAME}" — ${group.participants.length} participants\n`);

  // Check if a data/recruiters.json already exists so we can preserve team assignments
  let existing = {};
  if (fs.existsSync("data/recruiters.json")) {
    try {
      const raw = fs.readFileSync("data/recruiters.json", "utf8");
      const data = JSON.parse(raw);
      // Build a lookup of phone → existing member data to preserve team assignments
      for (const [teamName, teamData] of Object.entries(data.teams)) {
        for (const member of teamData.members) {
          existing[member.phone] = { ...member, team: teamName };
          if (member.lid) existing[member.lid] = { ...member, team: teamName };
        }
      }
      console.log(`📂 Found existing data/recruiters.json — will preserve team assignments.\n`);
    } catch (e) {
      console.log("⚠️  Could not read existing data/recruiters.json, starting fresh.\n");
    }
  }

  const members = [];

  for (const participant of group.participants) {
    const rawId = participant.id._serialized; // e.g. "31612345678@c.us" or "207919@lid"
    const isLid = rawId.endsWith("@lid");
    const idValue = participant.id.user; // the number or LID without suffix

    // If WhatsApp gives us a LID instead of a phone number,
    // we store the LID as the phone for now. The bot will resolve
    // and save the real LID automatically when the person sends a message.
    let phone = isLid ? null : idValue;
    let lid = null; // bot will auto-populate this when person sends a message
    let name = "";
    let displayName = "";

    try {
      const contact = await client.getContactById(rawId);
      displayName = contact.pushname || contact.name || "";
      name = displayName; // default — can be overridden in JSON later

      // If we got a LID but the contact also exposes a phone number, grab it
      if (isLid && contact.number) {
        phone = contact.number;
      }
    } catch (e) {
      displayName = idValue;
      name = idValue;
    }

    // Check if we already know this person (preserve their name from existing JSON)
    const existingEntry = existing[phone] || existing[lid];
    if (existingEntry) {
      name = existingEntry.name; // keep the name they already had assigned
    }

    members.push({ phone, lid, name, displayName });

    const label = `${name || displayName}`.padEnd(25);
    const ids = [phone ? `📞 ${phone}` : null, lid ? `🔑 LID: ${lid}` : null]
      .filter(Boolean)
      .join("  ");
    console.log(`  ✓ ${label} ${ids}`);
  }

  // Rebuild the JSON — preserve existing team assignments, put new people in UNASSIGNED
  let output;
  if (fs.existsSync("data/recruiters.json")) {
    try {
      const raw = fs.readFileSync("data/recruiters.json", "utf8");
      output = JSON.parse(raw);

      // Update existing members with any new fields (lid, displayName)
      for (const [teamName, teamData] of Object.entries(output.teams)) {
        output.teams[teamName].members = teamData.members.map((m) => {
          const fresh = members.find(
            (f) => (f.phone && f.phone === m.phone) || (f.lid && f.lid === m.lid)
          );
          return fresh ? { ...m, ...fresh, name: m.name } : m; // keep existing name
        });
      }

      // Add truly new members to UNASSIGNED
      const allExistingPhones = Object.values(existing).map((e) => e.phone).filter(Boolean);
      const allExistingLids = Object.values(existing).map((e) => e.lid).filter(Boolean);
      const newMembers = members.filter(
        (m) =>
          (!m.phone || !allExistingPhones.includes(m.phone)) &&
          (!m.lid || !allExistingLids.includes(m.lid))
      );

      if (newMembers.length > 0) {
        if (!output.teams["❓ UNASSIGNED"]) output.teams["❓ UNASSIGNED"] = { members: [] };
        output.teams["❓ UNASSIGNED"].members.push(...newMembers);
        console.log(`\n➕ ${newMembers.length} new member(s) added to UNASSIGNED.`);
      }
    } catch (e) {
      output = buildFreshOutput(members);
    }
  } else {
    output = buildFreshOutput(members);
  }

  fs.writeFileSync("data/recruiters.json", JSON.stringify(output, null, 2), "utf8");
  console.log(`\n✅ Done! data/recruiters.json updated with ${members.length} members.`);
  console.log(`👉 Check UNASSIGNED in data/recruiters.json and move new people to their team.`);

  process.exit(0);
});

function buildFreshOutput(members) {
  return {
    teams: {
      "🦁 HOLLANDIA 🦁": { members: [] },
      "🍟 FLANDERS 🍟": { members: [] },
      "🌸 GERMANY 🌸": { members: [] },
      "🍺 WALLONIA 🍺": { members: [] },
      "❓ UNASSIGNED": { members },
    },
  };
}

client.initialize();