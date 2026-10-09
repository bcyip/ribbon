// USCCS Match Ribbon — standalone page showing the last 3 days' results plus the next 3 days' scheduled games,
// split into a Men's row and a Women's row. Each row is a single
// horizontally-scrollable strip, oldest on the left and most recent on the
// right - the page loads scrolled to the right edge of each row, so the
// most recent results are what's visible first, and scrolling left reveals
// results from further back.
//
// ARCHITECTURE: this app is a PURE READER. Every page load reads ONLY from
// Postgres (the same Supabase database the other apps share, specifically
// the `schedule_games_cache` table) - it never talks to SportsEngine at
// all, on the request path or otherwise.
//
// The background sync that used to live here (a timer pulling games from
// SportsEngine and upserting into schedule_games_cache, including the team
// logo columns) has been moved into admin_server.js (the admin console /
// misconduct app) - see that file's header comment and
// runAutomaticScheduleSync. That app already had its own manually-triggered
// "Sync Historical Games" button writing to this exact table, so
// consolidating the automatic timer there too means only ONE process talks
// to SportsEngine on a schedule, using ONE set of credentials
// (SE_DATA_REFRESH_TOKEN), rather than this app and the admin console each
// running their own separate background pulls against the same data.
//
// Practical implication: this app's data is only as fresh as the admin
// console's last sync run. If the admin console isn't deployed/running, or
// its automatic sync is misconfigured, this ribbon will just keep serving
// whatever was last cached - it has no fallback of its own.
//
// REQUIRED ENVIRONMENT VARIABLES:
//   DATABASE_URL - same Supabase Postgres instance the other apps use
//   PORT         - (optional) most hosts set this automatically

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8787;
const HTML_FILE = path.join(__dirname, 'index.html');

// How many days back the ribbon displays. Independent of however far back
// the admin console's sync happens to reach - this only controls the
// display window read from whatever's already cached.
const DISPLAY_DAYS_BACK = 3;    // results from the last 3 days (+ today)
const DISPLAY_DAYS_FORWARD = 3; // upcoming SCHEDULED games for the next 3 days
// Upcoming rows only count if the admin console's sync touched them recently:
// a game that was later rescheduled outside the synced window would otherwise
// linger in the cache with its old date and show as a phantom upcoming game.
const UPCOMING_MAX_STALENESS_HOURS = 3;

// ---------- Postgres ----------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[postgres] Unexpected error on idle client:', err.message);
});

// Division ID -> {name, gender} lookup, copied verbatim from the schedule
// monitor / other apps in this project (same 61 divisions). Used only to
// resolve a readable division name for the payload - not rendered in the
// ribbon UI itself, but kept for parity with the other apps' JSON shape.
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

function daysAheadEasternEnd(now, daysAhead) {
  const { year, month, day } = getEasternDateParts(now);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0) + daysAhead * 24 * 60 * 60 * 1000);
  const p = getEasternDateParts(probe);
  return getEasternDayBounds(p.year, p.month, p.day).end;
}

function daysAgoEasternStart(now, daysBack) {
  const { year, month, day } = getEasternDateParts(now);
  const todayUtcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const probe = new Date(todayUtcNoon.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const p = getEasternDateParts(probe);
  return getEasternDayBounds(p.year, p.month, p.day).start;
}

// ---------- Serving the ribbon from Postgres ----------

async function getRibbonPayload() {
  const now = new Date();
  const windowStart = daysAgoEasternStart(now, DISPLAY_DAYS_BACK);
  const windowEnd = daysAheadEasternEnd(now, DISPLAY_DAYS_FORWARD);
  const freshAfter = new Date(now.getTime() - UPCOMING_MAX_STALENESS_HOURS * 60 * 60 * 1000);

  const todayStart = daysAgoEasternStart(now, 0);
  const todayEnd = getEndOfTodayEastern(now);

  // Oldest on the left to newest on the right. What qualifies depends on the day:
  //  - before today: only games SportsEngine has a score for (so CANCELED /
  //    POSTPONED / never-scored games stay out);
  //  - today: games marked SCHEDULED or COMPLETED, whether or not they have
  //    kicked off yet or have a score;
  //  - after today: only games marked SCHEDULED.
  // Status is compared case-insensitively, and SCHEDULED rows must have been
  // refreshed by a recent sync so a game rescheduled outside the synced window
  // doesn't linger under its old date.
  const result = await pool.query(
    `SELECT game_id, start_time, division_id, gender, home_team, away_team, game_status, se_home_score, se_away_score, home_team_logo_url, away_team_logo_url
     FROM schedule_games_cache
     WHERE start_time >= $1 AND start_time <= $2
       AND (
         (start_time < $4 AND se_home_score IS NOT NULL AND se_away_score IS NOT NULL)
         OR (start_time >= $4 AND start_time <= $5
             AND (UPPER(game_status) = 'COMPLETED' OR (UPPER(game_status) = 'SCHEDULED' AND synced_at >= $3)))
         OR (start_time > $5 AND UPPER(game_status) = 'SCHEDULED' AND synced_at >= $3)
       )
     ORDER BY start_time ASC`,
    [windowStart, windowEnd, freshAfter, todayStart, todayEnd]
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
    homeTeamLogoUrl: r.home_team_logo_url,
    awayTeamLogoUrl: r.away_team_logo_url,
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
  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL is not set - /api/ribbon will fail.');
  }
  console.log('[ribbon] Reads only from schedule_games_cache - the admin console app owns keeping that table synced with SportsEngine (see its header comment).');
});
