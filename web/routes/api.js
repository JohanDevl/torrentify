const express = require('express');
const router = express.Router();
const axios = require('axios');
const config = require('../lib/config');
const media = require('../lib/media');
const events = require('../lib/events');
const regenerate = require('../lib/regenerate');
const db = require('../../db');

// GET /api/health - Quick health check
router.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// GET /api/stats - Dashboard statistics
router.get('/stats', (req, res) => {
  try {
    const stats = media.getStats();
    res.json(stats);
  } catch (err) {
    console.error('Error getting stats:', err);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

// GET /api/media/:type - List media items
router.get('/media/:type', (req, res) => {
  try {
    const { type } = req.params;
    const { search = '', sort = 'name_asc', page = 1, perPage = 24 } = req.query;

    if (!['films', 'series', 'musiques'].includes(type)) {
      return res.status(400).json({ error: 'Invalid media type' });
    }

    const result = media.listMedia(type, {
      search,
      sort,
      page: parseInt(page, 10) || 1,
      perPage: parseInt(perPage, 10) || 24
    });

    res.json(result);
  } catch (err) {
    console.error('Error listing media:', err);
    res.status(500).json({ error: 'Failed to list media' });
  }
});

// GET /api/media/:type/:name - Single item detail
router.get('/media/:type/:name', (req, res) => {
  try {
    const { type, name } = req.params;

    if (!['films', 'series', 'musiques'].includes(type)) {
      return res.status(400).json({ error: 'Invalid media type' });
    }

    if (!name || name.includes('..') || name.includes('/')) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    const detail = media.getMediaDetail(type, name);

    if (!detail) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    res.json(detail);
  } catch (err) {
    console.error('Error getting media detail:', err);
    res.status(500).json({ error: 'Failed to get media detail' });
  }
});

// GET /api/media/:type/:name/file/:filename - File content
router.get('/media/:type/:name/file/:filename', (req, res) => {
  try {
    const { type, name, filename } = req.params;

    if (!['films', 'series', 'musiques'].includes(type)) {
      return res.status(400).json({ error: 'Invalid media type' });
    }

    const content = media.getFileContent(type, name, filename);

    if (content === null) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.type('text/plain').send(content);
  } catch (err) {
    console.error('Error getting file content:', err);
    res.status(500).json({ error: 'Failed to get file content' });
  }
});

// POST /api/media/:type/:name/regenerate - Regenerate item
router.post('/media/:type/:name/regenerate', (req, res) => {
  try {
    const { type, name } = req.params;

    if (!['films', 'series', 'musiques'].includes(type)) {
      return res.status(400).json({ error: 'Invalid media type' });
    }

    regenerate.deleteArtifacts(type, name);
    const result = regenerate.triggerScan();

    if (result.error) {
      return res.status(500).json(result);
    }

    res.json({ status: 'Regeneration triggered' });
  } catch (err) {
    console.error('Error regenerating media:', err);
    res.status(500).json({ error: 'Failed to regenerate media' });
  }
});

// DELETE /api/media/:type/:name - Delete artifacts
router.delete('/media/:type/:name', (req, res) => {
  try {
    const { type, name } = req.params;

    if (!['films', 'series', 'musiques'].includes(type)) {
      return res.status(400).json({ error: 'Invalid media type' });
    }

    const result = regenerate.deleteArtifacts(type, name);
    res.json(result);
  } catch (err) {
    console.error('Error deleting artifacts:', err);
    res.status(500).json({ error: 'Failed to delete artifacts' });
  }
});

// PUT /api/media/:type/:name/override-id - Set TMDb/iTunes ID override
router.put('/media/:type/:name/override-id', async (req, res) => {
  try {
    const { type, name } = req.params;
    const { id } = req.body || {};

    if (!['films', 'series'].includes(type)) {
      return res.status(400).json({ error: 'Override only supported for films and series' });
    }

    if (!name || name.includes('..') || name.includes('/')) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    const tmdbId = parseInt(id, 10);
    if (!tmdbId || tmdbId <= 0) {
      return res.status(400).json({ error: 'Invalid TMDb ID' });
    }

    // Validate the TMDb ID exists
    const apiType = type === 'films' ? 'movie' : 'tv';
    const cfg = config.getConfig();
    const apiKey = cfg.tmdbApiKey;

    if (!apiKey) {
      return res.status(400).json({ error: 'TMDb API key not configured' });
    }

    let tmdbData;
    try {
      const tmdbRes = await axios.get(
        `https://api.themoviedb.org/3/${apiType}/${tmdbId}?api_key=${apiKey}&language=fr-FR`,
        { timeout: 10000 }
      );
      tmdbData = tmdbRes.data;
    } catch (err) {
      if (err.response?.status === 404) {
        return res.status(400).json({ error: `TMDb ID ${tmdbId} not found for type ${apiType}` });
      }
      return res.status(502).json({ error: 'Failed to validate TMDb ID' });
    }

    // Store override in DB
    db.setOverride(type, name, tmdbId, apiType);

    // Delete metadata artifacts (keep .torrent, .nfo, .srcinfo)
    regenerate.deleteMetadataArtifacts(type, name);

    // Trigger rescan
    const scanResult = regenerate.triggerScan();

    const title = tmdbData.title || tmdbData.name || '';
    res.json({ status: 'Override set', tmdbId, title, scanTriggered: !scanResult.error });
  } catch (err) {
    console.error('Error setting override:', err);
    res.status(500).json({ error: 'Failed to set override' });
  }
});

// DELETE /api/media/:type/:name/override-id - Remove TMDb ID override
router.delete('/media/:type/:name/override-id', (req, res) => {
  try {
    const { type, name } = req.params;

    if (!['films', 'series'].includes(type)) {
      return res.status(400).json({ error: 'Override only supported for films and series' });
    }

    if (!name || name.includes('..') || name.includes('/')) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    db.removeOverride(type, name);

    // Delete metadata artifacts to force re-detection
    regenerate.deleteMetadataArtifacts(type, name);

    // Trigger rescan
    const scanResult = regenerate.triggerScan();

    res.json({ status: 'Override removed', scanTriggered: !scanResult.error });
  } catch (err) {
    console.error('Error removing override:', err);
    res.status(500).json({ error: 'Failed to remove override' });
  }
});

// GET /api/config - Get current config
router.get('/config', (req, res) => {
  try {
    const cfg = config.getConfig();
    const masked = { ...cfg };
    if (masked.tmdbApiKey) {
      const key = masked.tmdbApiKey;
      masked.tmdbApiKey = '*'.repeat(key.length - 4) + key.slice(-4);
    }
    res.json(masked);
  } catch (err) {
    console.error('Error getting config:', err);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// PUT /api/config - Save config
router.put('/config', (req, res) => {
  try {
    const body = req.body;

    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Don't overwrite API key with masked value
    if (body.tmdbApiKey && /^\*+/.test(body.tmdbApiKey)) {
      const current = config.getConfig();
      body.tmdbApiKey = current.tmdbApiKey;
    }

    const success = config.saveConfig(body);

    if (!success) {
      return res.status(500).json({ error: 'Failed to save config' });
    }

    res.json({ status: 'Config saved' });
  } catch (err) {
    console.error('Error saving config:', err);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// POST /api/scan - Trigger manual scan
router.post('/scan', (req, res) => {
  try {
    const result = regenerate.triggerScan();

    if (result.error) {
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('Error triggering scan:', err);
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
});

// POST /api/scan/stop - Stop running scan
router.post('/scan/stop', (req, res) => {
  try {
    const result = regenerate.stopScan();

    if (result.error) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('Error stopping scan:', err);
    res.status(500).json({ error: 'Failed to stop scan' });
  }
});

// GET /api/events - SSE stream
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const status = events.getLastStatus();
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);

    // Send buffered logs to new connections
    const bufferedLogs = events.getLogBuffer();
    for (const log of bufferedLogs) {
      res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
    }

    const onProgress = (data) => res.write(`event: scan:progress\ndata: ${JSON.stringify(data)}\n\n`);
    const onComplete = (data) => res.write(`event: scan:complete\ndata: ${JSON.stringify(data)}\n\n`);
    const onLog = (data) => res.write(`event: log\ndata: ${JSON.stringify(data)}\n\n`);

    events.on('scan:progress', onProgress);
    events.on('scan:complete', onComplete);
    events.on('scan:log', onLog);

    const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      events.off('scan:progress', onProgress);
      events.off('scan:complete', onComplete);
      events.off('scan:log', onLog);
    });
  } catch (err) {
    console.error('Error in SSE connection:', err);
    res.end();
  }
});

// GET /api/status - Current status
router.get('/status', (req, res) => {
  try {
    const status = events.getLastStatus();
    res.json(status);
  } catch (err) {
    console.error('Error getting status:', err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// GET /api/images/tmdb/* - Proxy TMDb images
router.get('/images/tmdb/*', async (req, res) => {
  try {
    const imagePath = req.params[0];

    if (!imagePath || imagePath.includes('..')) {
      return res.status(400).json({ error: 'Invalid image path' });
    }

    const imageUrl = `https://image.tmdb.org/t/p/${imagePath}`;

    const response = await axios.get(imageUrl, {
      responseType: 'stream',
      timeout: 10000
    });

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');

    response.data.pipe(res);
  } catch (err) {
    console.error('Error proxying image:', err.message);
    res.status(404).json({ error: 'Image not found' });
  }
});

module.exports = router;
