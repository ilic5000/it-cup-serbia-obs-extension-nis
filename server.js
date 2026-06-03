'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3042;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Settings helpers ──────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  gameUrl: '',
  refreshInterval: 10,
  template: 'bar',
  logoBackground: true,
  overrides: {
    homeTeamName: '',
    awayTeamName: '',
    homeTeamLogo: '',
    awayTeamLogo: ''
  },
  goalOverlay: {
    displayDuration: 8,
    bgColor: '#0a0d1a',
    accentColor: '#16a34a',
    cardAccentColor: '#f5c518',
    redCardAccentColor: '#dc2626',
    textColor: '#f1f5f9'
  }
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        overrides:    { ...DEFAULT_SETTINGS.overrides,    ...(raw.overrides    || {}) },
        goalOverlay:  { ...DEFAULT_SETTINGS.goalOverlay,  ...(raw.goalOverlay  || {}) }
      };
    }
  } catch (_) { /* fall through to default */ }
  return { ...DEFAULT_SETTINGS, overrides: { ...DEFAULT_SETTINGS.overrides } };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// ── Game page scraper ─────────────────────────────────────────────────────────

async function scrapeGame(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OBS-IT-Cup/1.0)' },
    timeout: 12000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const base = new URL(url).origin;

  // Resolve relative image paths to absolute URLs
  const abs = (src) => {
    if (!src) return '';
    return src.startsWith('http') ? src : base + src;
  };

  // Teams (first = home, second = away)
  const teamEls = $('.game-header-team');
  const homeTeam = {
    name: $(teamEls[0]).find('h3').text().trim(),
    city: $(teamEls[0]).find('.matches-item-team-city').text().trim(),
    logo: abs($(teamEls[0]).find('img').attr('src'))
  };
  const awayTeam = {
    name: $(teamEls[1]).find('h3').text().trim(),
    city: $(teamEls[1]).find('.matches-item-team-city').text().trim(),
    logo: abs($(teamEls[1]).find('img').attr('src'))
  };

  // Score
  const scoreSpans = $('.game-header-score-nums span');
  const homeScore  = Number($(scoreSpans[0]).text().trim()) || 0;
  const awayScore  = Number($(scoreSpans[1]).text().trim()) || 0;

  // Penalties block (hidden by default)
  const penaltyEl       = $('.game-item-penalties');
  const penaltyStyle    = penaltyEl.attr('style') || '';
  const penaltiesVisible = !/display\s*:\s*none/i.test(penaltyStyle);
  const penaltiesScore  = $('#game-item-penalties-score').text().trim();

  // Match metadata
  const datetime = $('.game-header-datetime > p').first().text().trim();
  const srDivs   = $('.game-header-datetime > div').first().find('> div');
  const season   = $(srDivs[0]).find('span').text().trim();
  const round    = $(srDivs[1]).find('span').text().trim();
  const location = $('.game-location span').text().trim();

  return {
    homeTeam, awayTeam,
    homeScore, awayScore,
    penaltiesVisible, penaltiesScore,
    datetime, season, round, location,
    fetchedAt: new Date().toISOString()
  };
}

// ── Mock match mode ───────────────────────────────────────────────────────────
// Entirely in-memory; resets on server restart.
// Activated from the "Dev: Mock Match" panel in settings.html.

const MOCK_HOME_PLAYERS = [
  { name: 'Marko Petrović',    num: '10' },
  { name: 'Stefan Nikolić',    num: '9'  },
  { name: 'Nikola Jovanović',  num: '7'  },
  { name: 'Luka Đorđević',     num: '11' },
  { name: 'Milan Stanković',   num: '8'  },
];

const MOCK_AWAY_PLAYERS = [
  { name: 'Ivan Milošević',    num: '94' },
  { name: 'Srđan Tomašević',   num: '43' },
  { name: 'Đorđe Rađenović',   num: '8'  },
  { name: 'Nemanja Nešić',     num: '96' },
  { name: 'Vladimir Čitaković', num: '15' },
];

let mockState = {
  enabled:      false,
  homeTeam:     { name: 'HOME TEAM', city: '', logo: '' },
  awayTeam:     { name: 'AWAY TEAM', city: '', logo: '' },
  homeScore:    0,
  awayScore:    0,
  minute:       1,
  goals:        [],
  cards:        [],
  redCards:     [],
  autoInterval: 0,   // seconds; 0 = disabled
};
let _autoGoalTimer = null;

// ── Timer state ──────────────────────────────────────────────────────────────────
// Purely in-memory — resets on server restart, never persisted to settings.json

let timerState = {
  show:      false,
  direction: 'up',   // 'up' | 'down'
  initialMs: 0,      // starting value in ms (set by /configure)
  elapsedMs: 0,      // accumulated ms when last paused
  startedAt: null,   // Date.now() when last started; null = paused/stopped
};

function timerCurrentMs() {
  const elapsed = timerState.elapsedMs +
    (timerState.startedAt !== null ? (Date.now() - timerState.startedAt) : 0);
  if (timerState.direction === 'down') return Math.max(0, timerState.initialMs - elapsed);
  return timerState.initialMs + elapsed;
}

function mockAddGoal(team) {
  const isAway  = team === 'away';
  const players = isAway ? MOCK_AWAY_PLAYERS : MOCK_HOME_PLAYERS;
  const player  = players[Math.floor(Math.random() * players.length)];

  if (isAway) mockState.awayScore++;
  else        mockState.homeScore++;

  mockState.minute = Math.min(mockState.minute + Math.floor(Math.random() * 7) + 1, 90);

  mockState.goals.push({
    index:      mockState.goals.length,
    playerName: player.name,
    playerNum:  player.num,
    playerImg:  '',
    minute:     String(mockState.minute),
    isAway,
    scoreAfter: `${mockState.homeScore}-${mockState.awayScore}`,
  });
}

function mockAddCard(team) {
  const isAway  = team === 'away';
  const players = isAway ? MOCK_AWAY_PLAYERS : MOCK_HOME_PLAYERS;
  const player  = players[Math.floor(Math.random() * players.length)];

  mockState.minute = Math.min(mockState.minute + Math.floor(Math.random() * 5) + 1, 90);

  mockState.cards.push({
    index:      mockState.cards.length,
    playerName: player.name,
    playerNum:  player.num,
    playerImg:  '',
    minute:     String(mockState.minute),
    isAway,
  });
}

function mockAddRedCard(team) {
  const isAway  = team === 'away';
  const players = isAway ? MOCK_AWAY_PLAYERS : MOCK_HOME_PLAYERS;
  const player  = players[Math.floor(Math.random() * players.length)];

  mockState.minute = Math.min(mockState.minute + Math.floor(Math.random() * 5) + 1, 90);

  mockState.redCards.push({
    index:      mockState.redCards.length,
    playerName: player.name,
    playerNum:  player.num,
    playerImg:  '',
    minute:     String(mockState.minute),
    isAway,
  });
}

function startAutoGoalTimer() {
  clearInterval(_autoGoalTimer);
  _autoGoalTimer = null;
  if (mockState.enabled && mockState.autoInterval > 0) {
    _autoGoalTimer = setInterval(() => {
      if (!mockState.enabled) { clearInterval(_autoGoalTimer); return; }
      const team = Math.random() < 0.5 ? 'home' : 'away';
      mockAddGoal(team);
      console.log(`[Mock] Auto goal → ${mockState.homeScore}-${mockState.awayScore} (${team})`);
    }, mockState.autoInterval * 1000);
  }
}

// ── Mock control routes ───────────────────────────────────────────────────────

app.get('/api/mock/state', (_req, res) => {
  res.json(mockState);
});

app.post('/api/mock/enable', async (req, res) => {
  const { homeTeam, awayTeam, autoInterval } = req.body || {};
  mockState.enabled = true;

  // Try to pull team data from the configured game URL as the default source
  const settings = loadSettings();
  if (settings.gameUrl) {
    try {
      const scraped = await scrapeGame(settings.gameUrl);
      mockState.homeTeam.name = homeTeam?.name || scraped.homeTeam.name || 'HOME TEAM';
      mockState.homeTeam.city = scraped.homeTeam.city || '';
      mockState.homeTeam.logo = homeTeam?.logo || scraped.homeTeam.logo || '';
      mockState.awayTeam.name = awayTeam?.name || scraped.awayTeam.name || 'AWAY TEAM';
      mockState.awayTeam.city = scraped.awayTeam.city || '';
      mockState.awayTeam.logo = awayTeam?.logo || scraped.awayTeam.logo || '';
      console.log('[Mock] Team data pulled from game URL');
    } catch (err) {
      console.warn('[Mock] Could not scrape game URL, using provided values:', err.message);
      if (homeTeam?.name) mockState.homeTeam.name = homeTeam.name;
      if (homeTeam?.logo) mockState.homeTeam.logo = homeTeam.logo;
      if (awayTeam?.name) mockState.awayTeam.name = awayTeam.name;
      if (awayTeam?.logo) mockState.awayTeam.logo = awayTeam.logo;
    }
  } else {
    if (homeTeam?.name) mockState.homeTeam.name = homeTeam.name;
    if (homeTeam?.logo) mockState.homeTeam.logo = homeTeam.logo;
    if (awayTeam?.name) mockState.awayTeam.name = awayTeam.name;
    if (awayTeam?.logo) mockState.awayTeam.logo = awayTeam.logo;
  }

  if (autoInterval !== undefined) mockState.autoInterval = Math.max(0, Number(autoInterval) || 0);
  startAutoGoalTimer();
  console.log('[Mock] Mock mode ENABLED');
  res.json({ success: true, state: mockState });
});

app.post('/api/mock/disable', (_req, res) => {
  mockState.enabled = false;
  clearInterval(_autoGoalTimer);
  _autoGoalTimer = null;
  console.log('[Mock] Mock mode DISABLED');
  res.json({ success: true });
});

app.post('/api/mock/goal', (req, res) => {
  if (!mockState.enabled) return res.status(400).json({ error: 'Mock mode is not enabled.' });
  const team = (req.body || {}).team === 'away' ? 'away' : 'home';
  mockAddGoal(team);
  console.log(`[Mock] Manual goal → ${mockState.homeScore}-${mockState.awayScore} (${team})`);
  res.json({ success: true, state: mockState });
});

app.post('/api/mock/card', (req, res) => {
  if (!mockState.enabled) return res.status(400).json({ error: 'Mock mode is not enabled.' });
  const team = (req.body || {}).team === 'away' ? 'away' : 'home';
  mockAddCard(team);
  const last = mockState.cards.at(-1);
  console.log(`[Mock] Yellow card → ${last.playerName} (${team})`);
  res.json({ success: true, state: mockState });
});

app.post('/api/mock/red-card', (req, res) => {
  if (!mockState.enabled) return res.status(400).json({ error: 'Mock mode is not enabled.' });
  const team = (req.body || {}).team === 'away' ? 'away' : 'home';
  mockAddRedCard(team);
  const last = mockState.redCards.at(-1);
  console.log(`[Mock] Red card → ${last.playerName} (${team})`);
  res.json({ success: true, state: mockState });
});

app.post('/api/mock/reset', (_req, res) => {
  mockState.homeScore = 0;
  mockState.awayScore = 0;
  mockState.minute    = 1;
  mockState.goals     = [];
  mockState.cards     = [];
  mockState.redCards  = [];
  console.log('[Mock] Match reset');
  res.json({ success: true, state: mockState });
});

app.post('/api/mock/auto', (req, res) => {
  if (!mockState.enabled) return res.status(400).json({ error: 'Mock mode is not enabled.' });
  mockState.autoInterval = Math.max(0, Number((req.body || {}).interval) || 0);
  startAutoGoalTimer();
  console.log(`[Mock] Auto-goal interval set to ${mockState.autoInterval}s`);
  res.json({ success: true, autoInterval: mockState.autoInterval });
});
// ── Timer routes ──────────────────────────────────────────────────────────────────

app.get('/api/timer', (_req, res) => {
  res.json({
    show:      timerState.show,
    direction: timerState.direction,
    initialMs: timerState.initialMs,
    running:   timerState.startedAt !== null,
    currentMs: timerCurrentMs(),
  });
});

// Set direction + start time, stop if running, reset elapsed
app.post('/api/timer/configure', (req, res) => {
  const { direction, minutes, seconds } = req.body || {};
  if (timerState.startedAt !== null) {
    timerState.elapsedMs += Date.now() - timerState.startedAt;
    timerState.startedAt = null;
  }
  timerState.elapsedMs = 0;
  if (direction === 'up' || direction === 'down') timerState.direction = direction;
  const mins = Math.max(0, Number(minutes) || 0);
  const secs = Math.max(0, Math.min(59, Number(seconds) || 0));
  timerState.initialMs = (mins * 60 + secs) * 1000;
  res.json({ success: true, running: false, currentMs: timerCurrentMs() });
});

app.post('/api/timer/start', (_req, res) => {
  if (timerState.startedAt === null) {
    if (timerState.direction === 'down' && timerCurrentMs() === 0)
      return res.json({ success: false, reason: 'Countdown already at zero', currentMs: 0 });
    timerState.startedAt = Date.now();
    timerState.show = true;
  }
  res.json({ success: true, running: true, currentMs: timerCurrentMs() });
});

app.post('/api/timer/pause', (_req, res) => {
  if (timerState.startedAt !== null) {
    timerState.elapsedMs += Date.now() - timerState.startedAt;
    timerState.startedAt = null;
  }
  res.json({ success: true, running: false, currentMs: timerCurrentMs() });
});

app.post('/api/timer/reset', (_req, res) => {
  const wasRunning = timerState.startedAt !== null;
  timerState.elapsedMs = 0;
  timerState.startedAt = wasRunning ? Date.now() : null;
  res.json({ success: true, running: wasRunning, currentMs: timerCurrentMs() });
});

// Nudge the displayed time by delta (positive = add time, negative = subtract)
app.post('/api/timer/adjust', (req, res) => {
  const { minutes = 0, seconds = 0 } = req.body || {};
  const deltaMs = (Number(minutes) * 60 + Number(seconds)) * 1000;
  if (timerState.direction === 'up') {
    timerState.elapsedMs = Math.max(-timerState.initialMs, timerState.elapsedMs + deltaMs);
  } else {
    // countdown: positive delta adds displayed time → reduce elapsed
    timerState.elapsedMs = Math.max(0, timerState.elapsedMs - deltaMs);
  }
  res.json({ success: true, currentMs: timerCurrentMs() });
});

app.post('/api/timer/show', (req, res) => {
  timerState.show = !!(req.body || {}).show;
  res.json({ success: true, show: timerState.show });
});
// ── API routes ────────────────────────────────────────────────────────────────

// GET /api/settings — read current settings
app.get('/api/settings', (_req, res) => {
  res.json(loadSettings());
});

// POST /api/settings — save settings
app.post('/api/settings', (req, res) => {
  const body = req.body;

  if (body.gameUrl !== undefined && body.gameUrl !== '' && !isValidHttpUrl(body.gameUrl)) {
    return res.status(400).json({ error: 'Invalid game URL. Must start with http:// or https://' });
  }
  if (body.refreshInterval !== undefined) {
    const ri = Number(body.refreshInterval);
    if (!Number.isInteger(ri) || ri < 1 || ri > 3600) {
      return res.status(400).json({ error: 'Refresh interval must be between 1 and 3600 seconds.' });
    }
  }

  const current = loadSettings();
  const updated = {
    ...current,
    ...body,
    overrides:   { ...current.overrides,   ...(body.overrides   || {}) },
    goalOverlay: { ...current.goalOverlay, ...(body.goalOverlay || {}) }
  };
  saveSettings(updated);
  res.json({ success: true, settings: updated });
});

// GET /api/preview?url=... — scrape a URL without saving it
app.get('/api/preview', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidHttpUrl(url)) {
    return res.status(400).json({ error: 'A valid http/https URL is required.' });
  }
  try {
    const data = await scrapeGame(url);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not fetch game page: ${err.message}` });
  }
});

// GET /api/goal-events — play-by-play goal events used by the goal scorer overlay
async function scrapeGoalEvents(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OBS-IT-Cup/1.0)' },
    timeout: 12000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const base = new URL(url).origin;

  const abs = (src) => {
    if (!src) return '';
    return src.startsWith('http') ? src : base + src;
  };

  // Teams
  const teamEls = $('.game-header-team');
  const homeTeam = {
    name: $(teamEls[0]).find('h3').text().trim(),
    city: $(teamEls[0]).find('.matches-item-team-city').text().trim(),
    logo: abs($(teamEls[0]).find('img').attr('src'))
  };
  const awayTeam = {
    name: $(teamEls[1]).find('h3').text().trim(),
    city: $(teamEls[1]).find('.matches-item-team-city').text().trim(),
    logo: abs($(teamEls[1]).find('img').attr('src'))
  };

  // Collect all goal events from play-by-play
  const goals = [];
  $('[data-page="playByPlays"] .play-by-play-item').each((_i, el) => {
    const $el = $(el);
    if (!$el.find('.play-by-play-ball-icon').length) return;

    const isAway = $el.hasClass('play-by-play-item-away-team');
    const inner  = $el.find('.play-by-play-item-committer-inner').first();

    const playerName = inner.find('span:not(.play-by-play-teamname)').first().text().trim();
    const playerNum  = inner.find('b.play-by-play-player-num').first().text().trim();
    const playerImg  = abs(inner.find('.table-player-img img').attr('src') || '');

    // Extract minute from action name text (strip SVG, then match digit)
    const actionClone = inner.find('.play-by-play-action-name').first().clone();
    actionClone.find('svg').remove();
    const actionText  = actionClone.text().trim();
    const minuteMatch = actionText.match(/(\d+(?:\+\d+)?)/);
    const minute      = minuteMatch ? minuteMatch[1] : '';

    // Score after goal (e.g. "0-1")
    const scoreEl    = $el.find('.play-by-play-goal-result').first();
    const scoreAfter = scoreEl.length ? scoreEl.text().replace(/\s/g, '') : '';

    goals.push({ index: goals.length, playerName, playerNum, playerImg, minute, isAway, scoreAfter });
  });

  // Collect yellow card events
  const cards = [];
  $('[data-page="playByPlays"] .play-by-play-item').each((_i, el) => {
    const $el = $(el);
    if (!$el.find('.play-by-play-action-name .small-yellow-card-box').length) return;

    const isAway = $el.hasClass('play-by-play-item-away-team');
    const inner  = $el.find('.play-by-play-item-committer-inner').first();

    const playerName = inner.find('span:not(.play-by-play-teamname)').first().text().trim();
    const playerNum  = inner.find('b.play-by-play-player-num').first().text().trim();
    const playerImg  = abs(inner.find('.table-player-img img').attr('src') || '');

    const actionClone = inner.find('.play-by-play-action-name').first().clone();
    actionClone.find('svg, .small-yellow-card-box').remove();
    const actionText  = actionClone.text().trim();
    const minuteMatch = actionText.match(/(\d+(?:\+\d+)?)/);
    const minute      = minuteMatch ? minuteMatch[1] : '';

    cards.push({ index: cards.length, playerName, playerNum, playerImg, minute, isAway });
  });

  // Collect red card events
  const redCards = [];
  $('[data-page="playByPlays"] .play-by-play-item').each((_i, el) => {
    const $el = $(el);
    if (!$el.find('.play-by-play-action-name .small-red-card-box').length) return;

    const isAway = $el.hasClass('play-by-play-item-away-team');
    const inner  = $el.find('.play-by-play-item-committer-inner').first();

    const playerName = inner.find('span:not(.play-by-play-teamname)').first().text().trim();
    const playerNum  = inner.find('b.play-by-play-player-num').first().text().trim();
    const playerImg  = abs(inner.find('.table-player-img img').attr('src') || '');

    const actionClone = inner.find('.play-by-play-action-name').first().clone();
    actionClone.find('svg, .small-red-card-box').remove();
    const actionText  = actionClone.text().trim();
    const minuteMatch = actionText.match(/(\d+(?:\+\d+)?)/);
    const minute      = minuteMatch ? minuteMatch[1] : '';

    redCards.push({ index: redCards.length, playerName, playerNum, playerImg, minute, isAway });
  });

  return { homeTeam, awayTeam, goals, cards, redCards };
}

app.get('/api/goal-events', async (req, res) => {
  // Mock mode shortcut
  if (mockState.enabled) {
    return res.json({
      homeTeam:  mockState.homeTeam,
      awayTeam:  mockState.awayTeam,
      goals:     mockState.goals,
      cards:     mockState.cards,
      redCards:  mockState.redCards,
    });
  }

  const settings = loadSettings();
  if (!settings.gameUrl) {
    return res.status(400).json({ error: 'No game URL configured. Open /settings.html to set one.' });
  }
  try {
    const data = await scrapeGoalEvents(settings.gameUrl);
    const ov   = settings.overrides || {};
    if (ov.homeTeamName) data.homeTeam.name = ov.homeTeamName;
    if (ov.awayTeamName) data.awayTeam.name = ov.awayTeamName;
    if (ov.homeTeamLogo) data.homeTeam.logo = ov.homeTeamLogo;
    if (ov.awayTeamLogo) data.awayTeam.logo = ov.awayTeamLogo;
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/game-data — live data used by the overlay
app.get('/api/game-data', async (req, res) => {
  // Mock mode shortcut
  if (mockState.enabled) {
    return res.json({
      homeTeam:         mockState.homeTeam,
      awayTeam:         mockState.awayTeam,
      homeScore:        mockState.homeScore,
      awayScore:        mockState.awayScore,
      penaltiesVisible: false,
      penaltiesScore:   '',
      datetime:         new Date().toLocaleString('sr'),
      season:           'Mock Season',
      round:            'Mock Round',
      location:         'Dev Server',
      fetchedAt:        new Date().toISOString(),
    });
  }

  const settings = loadSettings();
  if (!settings.gameUrl) {
    return res.status(400).json({
      error: 'No game URL configured. Open /settings.html to set one.'
    });
  }
  try {
    const data = await scrapeGame(settings.gameUrl);

    // Apply user overrides
    const ov = settings.overrides || {};
    if (ov.homeTeamName) data.homeTeam.name = ov.homeTeamName;
    if (ov.awayTeamName) data.awayTeam.name = ov.awayTeamName;
    if (ov.homeTeamLogo) data.homeTeam.logo = ov.homeTeamLogo;
    if (ov.awayTeamLogo) data.awayTeam.logo = ov.awayTeamLogo;

    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Stats scraper + state ─────────────────────────────────────────────────────

async function scrapeStats(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OBS-IT-Cup/1.0)' },
    timeout: 12000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const $    = cheerio.load(html);
  const base = new URL(url).origin;
  const abs  = (src) => (!src ? '' : src.startsWith('http') ? src : base + src);

  // Player stats (Statistika igrača)
  const statsBoxes = $('[data-page="players"] .game-stats-box').toArray();

  const parsePlayerBox = (boxEl) => {
    const $box    = $(boxEl);
    const teamName = $box.find('.game-stats-box-team span').text().trim();
    const teamLogo = abs($box.find('.game-stats-box-team img').attr('src') || '');
    const players  = [];

    $box.find('tbody tr').each((_i, trEl) => {
      const tds = $(trEl).find('td');
      players.push({
        num:     $(tds[0]).text().trim(),
        name:    $(tds[1]).find('.notranslate').text().trim(),
        photo:   abs($(tds[1]).find('img').attr('src') || ''),
        goals:   Number($(tds[2]).text().trim()) || 0,
        assists: Number($(tds[3]).text().trim()) || 0,
        saves:   Number($(tds[4]).text().trim()) || 0,
        yellow:  Number($(tds[5]).text().trim()) || 0,
        red:     Number($(tds[6]).text().trim()) || 0
      });
    });
    return { teamName, teamLogo, players };
  };

  const homeStats = statsBoxes[0] ? parsePlayerBox(statsBoxes[0]) : { teamName: '', teamLogo: '', players: [] };
  const awayStats = statsBoxes[1] ? parsePlayerBox(statsBoxes[1]) : { teamName: '', teamLogo: '', players: [] };

  // Team stats (Timska statistika)
  const teamStats = [];
  $('[data-page="teams"] .team-stats-field-name').each((_i, el) => {
    const $el   = $(el);
    const field = $el.attr('data-field') || '';
    const label = $el.find('p').text().trim();
    const spans = $el.find('span');
    const homeVal = Number($(spans[0]).text().trim()) || 0;
    const awayVal = Number($(spans[1]).text().trim()) || 0;
    if (field) teamStats.push({ field, label, home: homeVal, away: awayVal });
  });

  return { home: homeStats, away: awayStats, teamStats };
}

let statsOverlayState = {
  visible:   false,
  type:      'players', // 'players' | 'teams'
  hideTimer: null
};

let _statsCache = { data: null, cachedAt: 0 };
const STATS_CACHE_TTL = 30000;

// GET /api/stats-overlay
app.get('/api/stats-overlay', async (_req, res) => {
  let statsData = null;

  const settings = loadSettings();

  if (mockState.enabled) {
    const emptyRow = (p) => ({ num: p.num || '', name: p.name || '', goals: 0, assists: 0, saves: 0, yellow: 0, red: 0 });
    statsData = {
      home:      { teamName: mockState.homeTeam.name, teamLogo: mockState.homeTeam.logo, players: MOCK_HOME_PLAYERS.map(emptyRow) },
      away:      { teamName: mockState.awayTeam.name, teamLogo: mockState.awayTeam.logo, players: MOCK_AWAY_PLAYERS.map(emptyRow) },
      teamStats: []
    };
  } else if (settings.gameUrl) {
    const now = Date.now();
    if (_statsCache.data && (now - _statsCache.cachedAt) < STATS_CACHE_TTL) {
      statsData = _statsCache.data;
    } else {
      try {
        statsData = await scrapeStats(settings.gameUrl);
        _statsCache = { data: statsData, cachedAt: now };
      } catch (_err) {
        statsData = _statsCache.data || null;
      }
    }

    if (statsData) {
      const ov = settings.overrides || {};
      if (ov.homeTeamName) statsData.home.teamName = ov.homeTeamName;
      if (ov.awayTeamName) statsData.away.teamName = ov.awayTeamName;
      if (ov.homeTeamLogo) statsData.home.teamLogo = ov.homeTeamLogo;
      if (ov.awayTeamLogo) statsData.away.teamLogo = ov.awayTeamLogo;
    }
  }

  res.json({
    visible:        statsOverlayState.visible,
    type:           statsOverlayState.type,
    logoBackground: settings.logoBackground !== false,
    home:           statsData?.home      || { teamName: '', teamLogo: '', players: [] },
    away:           statsData?.away      || { teamName: '', teamLogo: '', players: [] },
    teamStats:      statsData?.teamStats || []
  });
});

// POST /api/stats-overlay/show  — body: { type?, duration? }
app.post('/api/stats-overlay/show', (req, res) => {
  const { type = 'players', duration = 15 } = req.body || {};
  statsOverlayState.visible = true;
  statsOverlayState.type    = type === 'teams' ? 'teams' : 'players';

  if (statsOverlayState.hideTimer) { clearTimeout(statsOverlayState.hideTimer); statsOverlayState.hideTimer = null; }

  const dur = Number(duration) || 0;
  if (dur > 0) {
    statsOverlayState.hideTimer = setTimeout(() => {
      statsOverlayState.visible   = false;
      statsOverlayState.hideTimer = null;
    }, dur * 1000);
  }

  _statsCache.cachedAt = 0; // force fresh scrape on next poll
  res.json({ success: true, visible: true, type: statsOverlayState.type });
});

// POST /api/stats-overlay/hide
app.post('/api/stats-overlay/hide', (_req, res) => {
  if (statsOverlayState.hideTimer) { clearTimeout(statsOverlayState.hideTimer); statsOverlayState.hideTimer = null; }
  statsOverlayState.visible = false;
  res.json({ success: true, visible: false });
});

// GET /api/proxy-image?url=... — proxy team logos to avoid CORS in OBS browser
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidHttpUrl(url)) return res.status(400).end();

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    if (!upstream.ok) return res.status(upstream.status).end();

    const ct = upstream.headers.get('content-type') || '';
    if (!ct.startsWith('image/') && !ct.startsWith('application/octet-stream')) {
      return res.status(400).end();
    }

    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=300');
    upstream.body.pipe(res);
  } catch (_) {
    res.status(502).end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('');
  console.log('  ⚽  IT Cup OBS Extension');
  console.log('  ──────────────────────────────────────');
  console.log(`  Overlay       ->  http://localhost:${PORT}/overlay.html`);
  console.log(`  Goal Overlay  ->  http://localhost:${PORT}/goal-overlay.html`);
  console.log(`  Stats Overlay ->  http://localhost:${PORT}/stats-overlay.html`);
  console.log(`  Settings      ->  http://localhost:${PORT}/settings.html`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
