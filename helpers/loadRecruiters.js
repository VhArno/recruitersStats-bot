const { google } = require('googleapis');
const path = require('path');

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1P5Snu3mKXOoeAzBRSM-4HxlgENgSz7jyj8Peg32pNII";
const SHEET_NAME = 'Recruiters';
const CREDENTIALS_PATH = path.join(__dirname, "../data/google-credentials.json");

// Cache to avoid hammering the Sheets API on every message
// Refreshes every 5 minutes
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadRecruiters() {
    // Return cached data if still fresh
    if (cache && Date.now() - cacheTime < CACHE_TTL) {
        return cache;
    }

    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: CREDENTIALS_PATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:F`, // Columns: phone, name, displayName, lid, team, support
        });

        const rows = response.data.values;
        if (!rows || rows.length < 2) {
            console.warn('⚠️ Google Sheet is empty or missing data.');
            return cache ?? { teams: {}, lookup: {}, lidLookup: {}, nameLookup: {}, displayLookup: {} };
        }

        // First row is headers: phone | name | displayName | lid | team | support
        const [headers, ...dataRows] = rows;

        const teams = {};
        const lookup = {};
        const lidLookup = {};
        const nameLookup = {};
        const displayLookup = {};

        for (const row of dataRows) {
            const phone       = row[0]?.trim() || null;
            const name        = row[1]?.trim() || null;
            const displayName = row[2]?.trim() || null;
            const lid         = row[3]?.trim() || null;
            const team        = row[4]?.trim() || null;
            const support     = row[5]?.trim().toLowerCase() === 'true';

            if (!name) continue; // Skip empty rows

            const entry = { name, team, support };

            // Build lookup maps
            if (phone)       lookup[phone]                            = entry;
            if (lid)         lidLookup[lid]                           = entry;
            if (name)        nameLookup[name.toLowerCase()]           = entry;
            if (displayName) displayLookup[displayName.toLowerCase()] = entry;

            // Build teams structure (same as recruiters.json format)
            if (team) {
                if (!teams[team]) teams[team] = { members: [] };
                teams[team].members.push({ phone, name, displayName, lid, support });
            }
        }

        console.log(`✅ Loaded ${dataRows.length} recruiters from Google Sheets.`);

        cache = { teams, lookup, lidLookup, nameLookup, displayLookup };
        cacheTime = Date.now();
        return cache;

    } catch (err) {
        console.error('❌ Could not load recruiters from Google Sheets:', err.message);
        // Fall back to cache if available, otherwise return empty
        return cache ?? { teams: {}, lookup: {}, lidLookup: {}, nameLookup: {}, displayLookup: {} };
    }
}

// Call this after saving a LID to invalidate the cache
function invalidateRecruiterCache() {
    cache = null;
    cacheTime = 0;
}

module.exports = { loadRecruiters, invalidateRecruiterCache };