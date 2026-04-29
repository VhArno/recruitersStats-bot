const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { google } = require("googleapis");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

const GROUP_NAME = "🏆RM EU 275/1500 WEEKGOAL🏆";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1P5Snu3mKXOoeAzBRSM-4HxlgENgSz7jyj8Peg32pNII";
const SHEET_NAME = "Recruiters";
const CREDENTIALS_PATH = path.join(__dirname, "../data/google-credentials.json");

// ─────────────────────────────────────────────
// GOOGLE SHEETS HELPERS
// ─────────────────────────────────────────────

async function getSheetData() {
    const auth = new google.auth.GoogleAuth({
        keyFile: CREDENTIALS_PATH,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:F`,
    });

    return { sheets, auth, rows: response.data.values || [] };
}

async function writeToSheet(sheets, rows) {
    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: rows },
    });
}

// ─────────────────────────────────────────────
// WHATSAPP CLIENT
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

    // Load existing sheet data so we can preserve team assignments and bijspring
    console.log("📊 Loading existing Google Sheet data...");
    const { sheets, rows: existingRows } = await getSheetData();

    // Build lookup from existing sheet: phone → { team, bijspring, lid }
    const existingByPhone = {};
    const existingByLid = {};
    if (existingRows.length > 1) {
        const [, ...dataRows] = existingRows; // skip header row
        for (const row of dataRows) {
            const [phone, , , lid, team, bijspring] = row;
            const entry = { team: team || "", bijspring: bijspring || "FALSE", lid: lid || "" };
            if (phone) existingByPhone[phone.trim()] = entry;
            if (lid)   existingByLid[lid.trim()]     = entry;
        }
        console.log(`📂 Found ${dataRows.length} existing rows — will preserve team assignments.\n`);
    } else {
        console.log("📂 Sheet is empty, starting fresh.\n");
    }

    // Fetch all group members
    const newRows = [
        ["phone", "name", "displayName", "lid", "team", "bijspring"], // header
    ];

    for (const participant of group.participants) {
        const rawId = participant.id._serialized;
        const isLid = rawId.endsWith("@lid");
        const idValue = participant.id.user;

        let phone = isLid ? null : idValue;
        let lid = isLid ? idValue : null;
        let name = "";
        let displayName = "";

        try {
            const contact = await client.getContactById(rawId);
            displayName = contact.pushname || contact.name || "";
            name = displayName;
            if (isLid && contact.number) phone = contact.number;
        } catch (e) {
            displayName = idValue;
            name = idValue;
        }

        // Look up existing entry to preserve team & bijspring
        const existing = (phone && existingByPhone[phone]) || (lid && existingByLid[lid]);
        const team     = existing?.team     ?? "";
        const bijspring = existing?.bijspring ?? "FALSE";
        // Preserve existing LID if we already had one
        const resolvedLid = lid || existing?.lid || "";

        newRows.push([
            phone        ?? "",
            name         ?? "",
            displayName  ?? "",
            resolvedLid  ?? "",
            team,
            bijspring,
        ]);

        const label = (name || displayName).padEnd(25);
        const ids = [phone ? `📞 ${phone}` : null, resolvedLid ? `🔑 LID: ${resolvedLid}` : null]
            .filter(Boolean)
            .join("  ");
        const teamLabel = team ? ` → ${team}` : " → (unassigned)";
        console.log(`  ✓ ${label} ${ids}${teamLabel}`);
    }

    // Write all rows to sheet
    console.log(`\n📤 Writing ${newRows.length - 1} members to Google Sheet...`);
    await writeToSheet(sheets, newRows);

    console.log(`\n✅ Done! Google Sheet updated with ${newRows.length - 1} members.`);
    console.log(`👉 Open the sheet and assign teams to anyone showing "(unassigned)".`);

    process.exit(0);
});

client.initialize();