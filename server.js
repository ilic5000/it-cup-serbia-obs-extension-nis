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
  }
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        overrides: { ...DEFAULT_SETTINGS.overrides, ...(raw.overrides || {}) }
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
    logo: abs($(teamEls[0]).find('img').attr('src'))
  };
  const awayTeam = {
    name: $(teamEls[1]).find('h3').text().trim(),
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
    overrides: { ...current.overrides, ...(body.overrides || {}) }
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

// GET /api/game-data — live data used by the overlay
app.get('/api/game-data', async (req, res) => {
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
  console.log(`  Overlay  ->  http://localhost:${PORT}/overlay.html`);
  console.log(`  Settings ->  http://localhost:${PORT}/settings.html`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
