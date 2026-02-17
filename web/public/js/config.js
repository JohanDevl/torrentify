document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();

  document.getElementById('btn-save').addEventListener('click', () => saveConfig(false));
  document.getElementById('btn-save-scan').addEventListener('click', () => saveConfig(true));

  // Cron presets
  document.querySelectorAll('[data-cron]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('cfg-schedule').value = btn.dataset.cron;
      updateScheduleDescription(btn.dataset.cron);
    });
  });

  document.getElementById('cfg-schedule').addEventListener('input', (e) => {
    updateScheduleDescription(e.target.value);
  });

  document.querySelectorAll('[id^="cfg-img-"]').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.id.replace('cfg-img-', '');
      const preview = document.getElementById(`preview-${key}`);
      if (preview) {
        preview.src = input.value;
        preview.onerror = () => {
          preview.src = '';
        };
      }
    });
  });
});

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Failed to load config');
    const config = await response.json();

    document.getElementById('cfg-trackers').value = (config.trackers || []).join('\n');
    document.getElementById('cfg-tmdb-key').value = config.tmdbApiKey || '';
    document.getElementById('cfg-films').checked = config.enableFilms || false;
    document.getElementById('cfg-series').checked = config.enableSeries || false;
    document.getElementById('cfg-musiques').checked = config.enableMusiques || false;
    document.getElementById('cfg-films-dirs').value = (config.filmsDirs || []).join(', ');
    document.getElementById('cfg-series-dirs').value = (config.seriesDirs || []).join(', ');
    document.getElementById('cfg-musiques-dirs').value = (config.musiquesDirs || []).join(', ');
    document.getElementById('cfg-prez').checked = config.enablePrez !== false;
    document.getElementById('cfg-parallel').value = config.parallelJobs || 1;
    document.getElementById('cfg-cooldown').value = config.scanCooldown || 5;
    document.getElementById('cfg-schedule').value = config.scanSchedule || '';
    updateScheduleDescription(config.scanSchedule || '');

    const images = config.prezImages || {};
    ['info', 'synopsis', 'movie', 'serie', 'download', 'link'].forEach(key => {
      const input = document.getElementById(`cfg-img-${key}`);
      const preview = document.getElementById(`preview-${key}`);
      if (input && images[key]) {
        input.value = images[key];
        if (preview) {
          preview.src = images[key];
          preview.onerror = () => {
            preview.src = '';
          };
        }
      }
    });
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function collectConfig() {
  return {
    trackers: document.getElementById('cfg-trackers').value.split('\n').map(t => t.trim()).filter(Boolean),
    tmdbApiKey: document.getElementById('cfg-tmdb-key').value.trim(),
    enableFilms: document.getElementById('cfg-films').checked,
    enableSeries: document.getElementById('cfg-series').checked,
    enableMusiques: document.getElementById('cfg-musiques').checked,
    enablePrez: document.getElementById('cfg-prez').checked,
    parallelJobs: parseInt(document.getElementById('cfg-parallel').value) || 1,
    scanCooldown: parseInt(document.getElementById('cfg-cooldown').value) || 5,
    scanSchedule: document.getElementById('cfg-schedule').value.trim(),
    filmsDirs: document.getElementById('cfg-films-dirs').value.split(',').map(d => d.trim()).filter(Boolean),
    seriesDirs: document.getElementById('cfg-series-dirs').value.split(',').map(d => d.trim()).filter(Boolean),
    musiquesDirs: document.getElementById('cfg-musiques-dirs').value.split(',').map(d => d.trim()).filter(Boolean),
    prezImages: Object.fromEntries(
      ['info', 'synopsis', 'movie', 'serie', 'download', 'link'].map(key => [
        key, document.getElementById(`cfg-img-${key}`)?.value.trim() || ''
      ])
    )
  };
}

const CRON_DESCRIPTIONS = {
  '0 */6 * * *': 'Toutes les 6 heures',
  '0 */12 * * *': 'Toutes les 12 heures',
  '0 0 * * *': 'Chaque jour a minuit',
  '0 3 * * *': 'Chaque jour a 3h du matin',
  '*/30 * * * *': 'Toutes les 30 minutes',
  '0 */1 * * *': 'Toutes les heures'
};

function updateScheduleDescription(expr) {
  const el = document.getElementById('schedule-description');
  if (!expr) {
    el.textContent = 'Scan planifie desactive';
    return;
  }
  if (CRON_DESCRIPTIONS[expr]) {
    el.textContent = CRON_DESCRIPTIONS[expr];
    return;
  }
  // Basic validation: 5 fields separated by spaces
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 5) {
    el.textContent = 'Expression cron personnalisee';
  } else {
    el.textContent = 'Expression invalide (5 champs requis: min heure jour mois jour_semaine)';
  }
}

async function saveConfig(andScan) {
  try {
    const config = collectConfig();

    if (!config.trackers.length) {
      showToast('Au moins un tracker requis', 'error');
      return;
    }

    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    if (!response.ok) throw new Error('Failed to save config');

    showToast('Configuration sauvegardee', 'success');

    if (andScan) {
      const scanResponse = await fetch('/api/scan', { method: 'POST' });
      if (!scanResponse.ok) throw new Error('Failed to start scan');
      showToast('Scan lance', 'success');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}
