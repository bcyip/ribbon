// USCCS Match Ribbon — standalone page showing the last 7 days' completed
// results, split into a Men's row and a Women's row. Each row is a single
// horizontally-scrollable strip, oldest on the left and most recent on the
// right - the page loads scrolled to the right edge of each row, so the
// most recent results are what's visible first, and scrolling left reveals
// results from further back.
//
// ARCHITECTURE: every page load reads ONLY from Postgres (the same
// Supabase database the other apps share, specifically the
// `schedule_games_cache` table admin_server.js already maintains for its
// own match-reports page) - never a live SportsEngine call on the request
// path. A live SportsEngine pull across the whole org is genuinely slow
// (multiple paginated GraphQL round trips), which is exactly what made the
// original all-live-queries version of this app too slow to be usable.
//
// Instead, a background job on a timer (runScheduleSync, see below) is the
// ONLY thing that talks to SportsEngine, and it does so off the request
// path entirely: it pulls the last several days of games and upserts them
// into schedule_games_cache, the same table admin_server.js's own "Sync
// Historical Games" button writes to (same schema, same ON CONFLICT
// upsert) - so this app's background sync also keeps that shared cache
// fresher for the admin console, as a side benefit, without either app
// needing to know about the other's sync runs.
//
// REQUIRED ENVIRONMENT VARIABLES:
//   DATABASE_URL                    - same Supabase Postgres instance the other apps use
//   SE_CLIENT_ID, SE_CLIENT_SECRET  - same SportsEngine app registration used elsewhere
//   SE_RIBBON_REFRESH_TOKEN         - this app's OWN refresh token (never reused across apps -
//                                      see the notes from setting this app up for how to get one)
//   SE_ORG_ID                       - same org ID used everywhere else (e.g. 356507)
//   SYNC_INTERVAL_MINUTES           - (optional) how often the background sync runs, defaults to 60
//   PORT                            - (optional) most hosts set this automatically

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8787;
const HTML_FILE = path.join(__dirname, 'index.html');

const SE_CLIENT_ID = process.env.SE_CLIENT_ID;
const SE_CLIENT_SECRET = process.env.SE_CLIENT_SECRET;
const SE_RIBBON_REFRESH_TOKEN = process.env.SE_RIBBON_REFRESH_TOKEN;
const SE_ORG_ID = process.env.SE_ORG_ID;
const SYNC_INTERVAL_MINUTES = parseFloat(process.env.SYNC_INTERVAL_MINUTES || '60');

// How many days back the ribbon displays and syncs. Synced with a 1-day
// buffer beyond the display window (see runScheduleSync) so the display
// window is always fully covered even right at a sync boundary.
const DISPLAY_DAYS_BACK = 6; // + today = 7 days total

// ---------- Postgres ----------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[postgres] Unexpected error on idle client:', err.message);
});

// ---------- SportsEngine OAuth (same pattern as the other apps) ----------

let tokenCache = { accessToken: null, expiresAt: 0 };

function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    if (!SE_CLIENT_ID || !SE_CLIENT_SECRET || !SE_RIBBON_REFRESH_TOKEN) {
      return reject(new Error('Missing SE_CLIENT_ID / SE_CLIENT_SECRET / SE_RIBBON_REFRESH_TOKEN environment variables.'));
    }
    const body = JSON.stringify({
      client_id: SE_CLIENT_ID,
      client_secret: SE_CLIENT_SECRET,
      refresh_token: SE_RIBBON_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    const req = https.request(
      {
        hostname: 'user.sportsengine.com',
        path: '/oauth/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.access_token) return reject(new Error('Token refresh failed: ' + data));
            tokenCache.accessToken = json.access_token;
            tokenCache.expiresAt = Date.now() + (json.expires_in || 1800) * 1000 - 60000;
            resolve(tokenCache.accessToken);
          } catch (e) {
            reject(new Error('Could not parse token response: ' + data));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getValidAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) return tokenCache.accessToken;
  return refreshAccessToken();
}

async function callGraphQL(query, variables) {
  const token = await getValidAccessToken();
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.sportsengine.com',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer ' + token,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.errors) return reject(new Error('GraphQL error: ' + JSON.stringify(json.errors)));
            resolve(json.data);
          } catch (e) {
            reject(new Error('Non-JSON response from SportsEngine: ' + data.slice(0, 300)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function seSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Division ID -> {name, gender} lookup, copied verbatim from the schedule
// monitor / other apps in this project (same 61 divisions).
const DIVISION_LOOKUP = {
  '6a4439745407815052443199': { name: 'AL/MS', gender: 'Men' },
  '6a4439745407813fac44341f': { name: 'Baltimore', gender: 'Men' },
  '6a0c980026aee381f43b3ef0': { name: 'Big Sky', gender: 'Men' },
  '6a4e96e416115e0153c5de9d': { name: 'Crossroads', gender: 'Men' },
  '6a44397409f291d00804fde8': { name: 'Florida North', gender: 'Men' },
  '6a4439744e42a26275c7ff31': { name: 'Florida South', gender: 'Men' },
  '6a443974b5457c8f19bccbfc': { name: 'Georgia', gender: 'Men' },
  '6a4e96e4c7769d01229fb5c6': { name: 'Great Lakes', gender: 'Men' },
  '6a4e96e47d61ac00f01ad8b8': { name: 'Great Lakes II', gender: 'Men' },
  '6a4e96e4801326012116f744': { name: 'Great Plains', gender: 'Men' },
  '6a4e96e46b8d1e00ef1ee690': { name: 'Heartland', gender: 'Men' },
  '6a4e96e416115e0122c5e2c1': { name: 'Heartland II', gender: 'Men' },
  '6a44397409f291e60904fdda': { name: 'Hudson Valley', gender: 'Men' },
  '6a443974b5457c54e4bcd12d': { name: 'KY/TN', gender: 'Men' },
  '6a0cb110cdb76433cc151485': { name: 'Midwest North', gender: 'Men' },
  '6a0e070026aee3f6e43b446f': { name: 'Midwest North II', gender: 'Men' },
  '6a0e0700cdb76416601513ae': { name: 'Midwest South', gender: 'Men' },
  '6a4e96e46b8d1e01201ee2ce': { name: 'Ozark', gender: 'Men' },
  '6a44397409f29192050500f1': { name: 'NC East', gender: 'Men' },
  '6a4439744e42a29553c7fe6c': { name: 'NC West', gender: 'Men' },
  '6a4439743c1d137b18c8db12': { name: 'New England Central', gender: 'Men' },
  '6a443974593ddf505e16a197': { name: 'New England North', gender: 'Men' },
  '6a44397454078160b344310a': { name: 'New England South', gender: 'Men' },
  '6a0c980026aee362b23b3f0e': { name: 'NorCal', gender: 'Men' },
  '6a0c980004d6b0c7a8af73bd': { name: 'NorCal II', gender: 'Men' },
  '6a0c980098c2fde79e7c20e8': { name: 'Northwest', gender: 'Men' },
  '6a0e08bbf841cfba91996998': { name: 'Northwoods', gender: 'Men' },
  '6a0e09e298c2fd5b067c22c4': { name: 'Northwoods II', gender: 'Men' },
  '6a4439744e42a24ee3c80243': { name: 'NYC', gender: 'Men' },
  '6a443974b5457c6597bccdad': { name: 'Philly', gender: 'Men' },
  '6a0e08bb61444a4db0f2ef89': { name: 'Prairie', gender: 'Men' },
  '6a4e96e48dabb800efcfbce9': { name: 'Red River', gender: 'Men' },
  '6a4e96e48dabb80151cfb8bd': { name: 'Red River II', gender: 'Men' },
  '6a4e96e4c7769d00f19fb81b': { name: 'Rocky Mountain', gender: 'Men' },
  '6a4e96e435cc6d00ef70bd6d': { name: 'Rocky Mountain II', gender: 'Men' },
  '6a4e96e4c7769d00bc9fbb3f': { name: 'Sabine River', gender: 'Men' },
  '6a4e96e48dabb80120cfb96d': { name: 'Sabine River II', gender: 'Men' },
  '6a0c980026aee3a5643b3edf': { name: 'SoCal', gender: 'Men' },
  '6a0c980098c2fd32fc7c1d07': { name: 'SoCal II', gender: 'Men' },
  '6a3ed52cf2a55d01e50c59e5': { name: 'SoCal III', gender: 'Men' },
  '6a4e96e480132600f016f99d': { name: 'Southwest', gender: 'Men' },
  '6a4e96e4c7769d01539fb593': { name: 'Southwest II', gender: 'Men' },
  '6a0c9800bc500ed1f8da9d08': { name: 'Utah', gender: 'Men' },
  '6a443974593ddf60ee169e3f': { name: 'Virginia', gender: 'Men' },
  '6a44397409f291bc4904fe1b': { name: 'Washington DC', gender: 'Men' },
  '6a4446b9c3ff52e2d366a921': { name: 'DMV', gender: 'Women' },
  '6a444639c3ff52b71466af8b': { name: 'FL', gender: 'Women' },
  '6a0e0a64a70302e718b84569': { name: 'Midwest', gender: 'Women' },
  '6a0e0a6498c2fd83787c1db1': { name: 'Midwest II', gender: 'Women' },
  '6a46cdfc06f455aa0cc3badb': { name: 'New England', gender: 'Women' },
  '6a0c982c61444a4e0cf2efa3': { name: 'NorCal', gender: 'Women' },
  '6a0c982c61444a7966f2eb9a': { name: 'NorCal II', gender: 'Women' },
  '6a0c982cf841cf9b0499667d': { name: 'Northwest', gender: 'Women' },
  '6a0c982c98c2fd32fc7c1d0d': { name: 'Oregon II', gender: 'Women' },
  '6a4e9b904b609600f0e70d42': { name: 'Ozark', gender: 'Women' },
  '6a44470e99ca5a7f419d52d3': { name: 'Philly', gender: 'Women' },
  '6a4e9b6a801326012116f792': { name: 'Rocky Mountain', gender: 'Women' },
  '6a4e9b6a4b60960121e70967': { name: 'Rocky Mountain II', gender: 'Women' },
  '6a0c982c98c2fd79027c1c4f': { name: 'SoCal', gender: 'Women' },
  '6a0c982c8a5826dcee7f909e': { name: 'SoCal II', gender: 'Women' },
  '6a4e9b6a80132600f016fa7f': { name: 'Southwest', gender: 'Women' },
};

const EVENTS_QUERY = `
  query Events($orgId: Int!, $from: UTCDateTime!, $to: UTCDateTime!, $page: Int!, $perPage: Int!) {
    events(organizationId: $orgId, from: $from, to: $to, calendarEventType: GAME, page: $page, perPage: $perPage) {
      results {
        id
        eventTeams { name score team { id program { primaryName } divisionId } homeTeam }
        start
        subvenue { name venueId venueName }
        gameStatus
      }
      pageInformation { count page pages }
    }
  }`;

function deriveGenderFromProgramName(primaryName) {
  if (!primaryName) return null;
  const lower = primaryName.toLowerCase();
  if (lower.includes('women')) return 'Women';
  if (lower.includes('men')) return 'Men';
  return null;
}

function extractGameInfo(event) {
  const teams = event.eventTeams || [];
  const home = teams.find((t) => t.homeTeam === true) || teams[0] || null;
  const away = teams.find((t) => t.homeTeam === false) || teams[1] || null;
  const subvenue = event.subvenue || {};
  const locationName = [subvenue.venueName, subvenue.name].filter(Boolean).join(' - ') || null;

  const divisionId = (home && home.team && home.team.divisionId) || (away && away.team && away.team.divisionId) || null;
  const divisionInfo = divisionId ? DIVISION_LOOKUP[divisionId] : null;

  const programName = (home && home.team && home.team.program && home.team.program.primaryName)
    || (away && away.team && away.team.program && away.team.program.primaryName) || null;
  const gender = deriveGenderFromProgramName(programName) || (divisionInfo && divisionInfo.gender) || null;

  return {
    eventId: event.id,
    startTime: event.start || null,
    locationName,
    homeTeam: (home && home.name) || null,
    awayTeam: (away && away.name) || null,
    homeTeamId: (home && home.team && home.team.id) || null,
    awayTeamId: (away && away.team && away.team.id) || null,
    divisionId,
    gender,
    gameStatus: event.gameStatus || null,
    homeScore: (home && home.score != null) ? home.score : null,
    awayScore: (away && away.score != null) ? away.score : null,
  };
}

async function fetchGamesInRange(from, to) {
  let allEvents = [];
  let page = 1;
  let totalPages = 1;
  const PER_PAGE = 40; // same conservative value used elsewhere in this project - 100/page hits SportsEngine's complexity limit
  const PAGE_DELAY_MS = 200; // this is a small, backgrounded sync, not a full-season pull - no need for a large inter-page delay

  do {
    const data = await callGraphQL(EVENTS_QUERY, { orgId: parseInt(SE_ORG_ID, 10), from, to, page, perPage: PER_PAGE });
    const pageResults = (data.events && data.events.results) || [];
    totalPages = (data.events && data.events.pageInformation && data.events.pageInformation.pages) || 1;
    allEvents = allEvents.concat(pageResults);
    page++;
    if (page <= totalPages) await seSleep(PAGE_DELAY_MS);
  } while (page <= totalPages);

  // Dedup by event ID - same pagination-drift safeguard used elsewhere in
  // this project.
  const seenIds = new Set();
  const deduped = [];
  for (const e of allEvents) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    deduped.push(e);
  }
  return deduped.map(extractGameInfo);
}

// ---------- Eastern-time day helpers ----------

function getEasternDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { year: parseInt(get('year'), 10), month: parseInt(get('month'), 10), day: parseInt(get('day'), 10), weekday: get('weekday') };
}

function getEasternDayBounds(y, m, d) {
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset',
  }).formatToParts(probe);
  const offsetHours = parseInt(offsetParts.find((p) => p.type === 'timeZoneName').value.replace('GMT', ''), 10);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetHours * 60 * 60 * 1000);
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - offsetHours * 60 * 60 * 1000 - 1000);
  return { start, end };
}

function getEndOfTodayEastern(now) {
  const { year, month, day } = getEasternDateParts(now);
  return getEasternDayBounds(year, month, day).end;
}

function daysAgoEasternStart(now, daysBack) {
  const { year, month, day } = getEasternDateParts(now);
  const todayUtcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const probe = new Date(todayUtcNoon.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const p = getEasternDateParts(probe);
  return getEasternDayBounds(p.year, p.month, p.day).start;
}

// ---------- Background sync: SportsEngine -> schedule_games_cache ----------
//
// The only thing in this app that ever calls SportsEngine. Runs on a timer,
// off the request path, and upserts into the SAME schedule_games_cache
// table admin_server.js's "Sync Historical Games" button uses (identical
// schema, identical ON CONFLICT upsert) - so this app's background runs
// also keep that shared cache fresher for the admin console.
//
// Pulls DISPLAY_DAYS_BACK + 1 days of buffer through the end of today
// (Eastern) - past games only, same "never sync past today" rule the admin
// console's own sync uses, since this cache is specifically for results
// that have already happened.
async function runScheduleSync() {
  const startedAt = Date.now();
  try {
    const now = new Date();
    const endOfTodayEastern = getEndOfTodayEastern(now);
    const rangeFrom = daysAgoEasternStart(now, DISPLAY_DAYS_BACK + 1); // 1 extra day of buffer

    const games = await fetchGamesInRange(rangeFrom.toISOString(), endOfTodayEastern.toISOString());
    const pastGames = games.filter((g) => g.startTime && new Date(g.startTime) <= endOfTodayEastern);

    let syncedCount = 0;
    for (const g of pastGames) {
      await pool.query(
        `INSERT INTO schedule_games_cache (game_id, start_time, division_id, gender, location_name, home_team, home_team_id, away_team, away_team_id, game_status, se_home_score, se_away_score, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (game_id) DO UPDATE SET
           start_time = EXCLUDED.start_time, division_id = EXCLUDED.division_id, gender = EXCLUDED.gender,
           location_name = EXCLUDED.location_name, home_team = EXCLUDED.home_team, home_team_id = EXCLUDED.home_team_id,
           away_team = EXCLUDED.away_team, away_team_id = EXCLUDED.away_team_id, game_status = EXCLUDED.game_status,
           se_home_score = EXCLUDED.se_home_score, se_away_score = EXCLUDED.se_away_score,
           synced_at = now()`,
        [g.eventId, g.startTime, g.divisionId, g.gender, g.locationName, g.homeTeam, g.homeTeamId, g.awayTeam, g.awayTeamId, g.gameStatus, g.homeScore, g.awayScore]
      );
      syncedCount++;
    }

    console.log(`[schedule-sync] Synced ${syncedCount} games in ${Date.now() - startedAt}ms.`);
  } catch (err) {
    // Never let a failed sync crash the server or block the next scheduled
    // attempt - the ribbon just serves whatever's already cached until the
    // next run succeeds.
    console.error('[schedule-sync] Error (will retry on next scheduled run):', err.message);
  }
}

// ---------- Serving the ribbon from Postgres ----------

async function getRibbonPayload() {
  const now = new Date();
  const windowStart = daysAgoEasternStart(now, DISPLAY_DAYS_BACK);
  const windowEnd = getEndOfTodayEastern(now);

  const result = await pool.query(
    `SELECT game_id, start_time, division_id, gender, home_team, away_team, game_status, se_home_score, se_away_score
     FROM schedule_games_cache
     WHERE start_time >= $1 AND start_time <= $2
     ORDER BY start_time ASC`,
    [windowStart, windowEnd]
  );

  const games = result.rows.map((r) => ({
    gameId: r.game_id,
    startTime: r.start_time,
    divisionName: (DIVISION_LOOKUP[r.division_id] && DIVISION_LOOKUP[r.division_id].name) || null,
    gender: r.gender,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    gameStatus: r.game_status,
    isCompleted: r.game_status === 'COMPLETED',
    homeScore: r.se_home_score,
    awayScore: r.se_away_score,
  }));

  const men = games.filter((g) => g.gender === 'Men');
  const women = games.filter((g) => g.gender === 'Women');

  return { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), men, women };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/ribbon') {
    try {
      const payload = await getRibbonPayload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      console.error('[api/ribbon] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(HTML_FILE, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('index.html not found — make sure it is in the same folder as server.js');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Match ribbon running on port ${PORT}`);
  if (!SE_CLIENT_ID || !SE_CLIENT_SECRET || !SE_RIBBON_REFRESH_TOKEN || !SE_ORG_ID) {
    console.warn('WARNING: one or more SportsEngine env vars are missing (SE_CLIENT_ID, SE_CLIENT_SECRET, SE_RIBBON_REFRESH_TOKEN, SE_ORG_ID) - the background sync will fail until they are set, and the ribbon will only ever show whatever is already cached.');
  }
  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL is not set - /api/ribbon will fail.');
  }
  // Run once immediately on startup so there's data to show right away,
  // then on the configured interval from then on.
  runScheduleSync();
  setInterval(runScheduleSync, SYNC_INTERVAL_MINUTES * 60 * 1000);
});
