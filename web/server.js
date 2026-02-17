const express = require('express');
const path = require('path');
const cron = require('node-cron');
const config = require('./lib/config');
const regenerate = require('./lib/regenerate');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

try {
  const apiRoutes = require('./routes/api');
  app.use('/api', apiRoutes);
} catch (err) {
  console.warn('API routes not available yet:', err.message);
}

try {
  const pageRoutes = require('./routes/pages');
  app.use('/', pageRoutes);
} catch (err) {
  console.warn('Page routes not available yet:', err.message);
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// --- Cron scheduler ---
let scheduledTask = null;

function setupCronSchedule() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  const cfg = config.getConfig();
  const schedule = cfg.scanSchedule;

  if (!schedule) return;

  if (!cron.validate(schedule)) {
    console.warn(`Invalid cron expression: "${schedule}"`);
    return;
  }

  scheduledTask = cron.schedule(schedule, () => {
    console.log('Scheduled scan triggered');
    regenerate.triggerScan();
  });

  console.log(`Scan scheduled: ${schedule}`);
}

// Re-apply schedule when config is saved
const originalSave = config.saveConfig;
config.saveConfig = function(data) {
  const result = originalSave(data);
  if (result) setupCronSchedule();
  return result;
};

setupCronSchedule();

const PORT = process.env.WEB_PORT || 5765;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = app;
