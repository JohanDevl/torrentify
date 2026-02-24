const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, '..', 'views');
const buildTs = Date.now();

function sendPage(res, viewName, replacements = {}) {
  try {
    let html = fs.readFileSync(path.join(viewsDir, 'layout.html'), 'utf8');
    const page = fs.readFileSync(path.join(viewsDir, `${viewName}.html`), 'utf8');
    html = html.replace('<!--PAGE_CONTENT-->', page);
    const jsFile = viewName === 'media-detail' ? 'media' : viewName.replace(/-/g, '');
    html = html.replace('/js/app.js', `/js/app.js?v=${buildTs}`);
    html = html.replace('</body>', `<script src="/js/${jsFile}.js?v=${buildTs}"></script>\n</body>`);
    for (const [key, value] of Object.entries(replacements)) {
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    res.type('html').send(html);
  } catch (err) {
    console.error(`Error sending page ${viewName}:`, err.message);
    res.status(500).send('Page not found');
  }
}

router.get('/', (req, res) => sendPage(res, 'dashboard'));

router.get('/media/:type', (req, res) => {
  const { type } = req.params;
  if (!['films', 'series', 'musiques'].includes(type)) {
    return res.status(404).send('Not found');
  }
  sendPage(res, 'media', { MEDIA_TYPE: type });
});

router.get('/media/:type/:name', (req, res) => {
  const { type, name } = req.params;
  if (!['films', 'series', 'musiques'].includes(type)) {
    return res.status(404).send('Not found');
  }
  sendPage(res, 'media-detail', { MEDIA_TYPE: type, MEDIA_NAME: name });
});

router.get('/config', (req, res) => sendPage(res, 'config'));

router.get('/logs', (req, res) => sendPage(res, 'logs'));

module.exports = router;
