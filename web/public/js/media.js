/* Media Browser & Detail Page */

document.addEventListener('DOMContentLoaded', () => {
  if (window.__MEDIA_NAME__) {
    initDetailPage();
  } else if (window.__MEDIA_TYPE__) {
    initBrowserPage();
  }
});

// ============================================================================
// BROWSER PAGE
// ============================================================================

let currentPage = 1;
let currentSearch = '';
let currentSort = 'name_asc';
let totalPages = 1;

async function initBrowserPage() {
  const type = window.__MEDIA_TYPE__;
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  document.getElementById('media-type-label').textContent = typeLabel;

  document.getElementById('search').addEventListener('input', debounce(onSearch, 300));
  document.getElementById('sort').addEventListener('change', onSort);

  await loadMedia();
}

async function loadMedia() {
  const type = window.__MEDIA_TYPE__;
  const params = new URLSearchParams({
    page: currentPage,
    sort: currentSort,
    perPage: 24,
    ...(currentSearch && { search: currentSearch })
  });

  try {
    const data = await api(`/media/${type}?${params}`);
    renderGrid(data.items || []);
    renderPagination(data.total || 0, data.page || 1, data.totalPages || 1);
    totalPages = data.totalPages || 1;
  } catch (err) {
    console.error('Error loading media:', err);
    document.getElementById('media-grid').innerHTML =
      `<div class="empty-state"><div class="empty-state-title">Erreur: ${err.message}</div></div>`;
  }
}

function renderGrid(items) {
  const grid = document.getElementById('media-grid');

  if (!items || items.length === 0) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">Aucun element trouve</div></div>';
    return;
  }

  grid.innerHTML = items.map(item => `
    <a href="/media/${window.__MEDIA_TYPE__}/${encodeURIComponent(item.name)}" class="media-card" style="text-decoration: none; color: inherit;">
      <div class="media-card-poster" style="font-size: 32px;">
        ${getMediaIcon(window.__MEDIA_TYPE__)}
      </div>
      <div class="media-card-content">
        <div class="media-card-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="media-card-info" style="margin-top: auto;">
          ${formatDate(item.modifiedAt || item.updatedAt || new Date())}
        </div>
        <div class="media-card-status" style="margin-top: var(--spacing-sm);">
          <span class="badge ${item.files?.torrent ? 'badge-success' : 'badge-error'}" title=".torrent">.torrent</span>
          <span class="badge ${item.files?.nfo ? 'badge-success' : 'badge-error'}" title=".nfo">.nfo</span>
          <span class="badge ${item.files?.txt ? 'badge-success' : 'badge-error'}" title=".txt">.txt</span>
          ${window.__MEDIA_TYPE__ !== 'musiques' ? `<span class="badge ${item.files?.prez ? 'badge-success' : 'badge-error'}" title=".prez">.prez</span>` : ''}
        </div>
      </div>
    </a>
  `).join('');
}

function renderPagination(total, page, totalPages) {
  const paginationEl = document.getElementById('pagination');

  if (totalPages <= 1) {
    paginationEl.innerHTML = '';
    return;
  }

  let html = '';

  if (page > 1) {
    html += `<button class="btn btn-secondary btn-small" onclick="goToPage(1)">« Premier</button>`;
    html += `<button class="btn btn-secondary btn-small" onclick="goToPage(${page - 1})">‹ Precedent</button>`;
  }

  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);

  if (start > 1) html += '<span style="color: var(--text-muted);">...</span>';

  for (let i = start; i <= end; i++) {
    if (i === page) {
      html += `<button class="btn btn-primary btn-small" disabled>${i}</button>`;
    } else {
      html += `<button class="btn btn-secondary btn-small" onclick="goToPage(${i})">${i}</button>`;
    }
  }

  if (end < totalPages) html += '<span style="color: var(--text-muted);">...</span>';

  if (page < totalPages) {
    html += `<button class="btn btn-secondary btn-small" onclick="goToPage(${page + 1})">Suivant ›</button>`;
    html += `<button class="btn btn-secondary btn-small" onclick="goToPage(${totalPages})">Dernier »</button>`;
  }

  paginationEl.innerHTML = html;
}

function onSearch(e) {
  currentSearch = e.target.value.trim();
  currentPage = 1;
  loadMedia();
}

function onSort(e) {
  currentSort = e.target.value;
  currentPage = 1;
  loadMedia();
}

function goToPage(page) {
  if (page >= 1 && page <= totalPages) {
    currentPage = page;
    loadMedia();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ============================================================================
// DETAIL PAGE
// ============================================================================

async function initDetailPage() {
  const type = window.__MEDIA_TYPE__;
  const name = window.__MEDIA_NAME__;
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

  document.getElementById('media-type-label').textContent = typeLabel;
  document.getElementById('detail-title').textContent = decodeURIComponent(name);

  document.getElementById('btn-regenerate').addEventListener('click', () => regenerateItem(type, name));
  document.getElementById('btn-delete').addEventListener('click', () => deleteItem(type, name));

  let detail;
  try {
    detail = await api(`/media/${type}/${encodeURIComponent(name)}`);
  } catch (err) {
    console.error('Error loading detail:', err);
    showToast(err.message, 'error');

    document.getElementById('metadata-content').innerHTML =
      '<div class="empty-state" style="min-height: 150px;"><div class="empty-state-title">Erreur de chargement</div><div style="font-size: 13px; color: var(--text-muted); margin-top: var(--spacing-sm);">' + escapeHtml(err.message) + '</div></div>';

    document.getElementById('file-tabs').innerHTML = '';
    document.getElementById('file-viewer').innerHTML =
      '<div class="empty-state" style="min-height: 200px;"><div class="empty-state-title">Impossible de charger les fichiers</div></div>';

    document.getElementById('source-content').textContent = 'Erreur de chargement';
    return;
  }

  // Metadata section
  try {
    if (detail.metadata) {
      renderMetadata(detail.metadata, type);
    } else {
      document.getElementById('metadata-content').innerHTML =
        '<div class="empty-state" style="min-height: 150px;"><div class="empty-state-title">Pas de metadata disponible</div></div>';
    }
  } catch (err) {
    console.error('Error rendering metadata:', err);
    document.getElementById('metadata-content').innerHTML =
      '<div class="empty-state" style="min-height: 150px;"><div class="empty-state-title">Erreur d\'affichage metadata</div></div>';
  }

  // Files section
  try {
    if (detail.files && detail.files.length > 0) {
      renderFileTabs(detail.files, type, name);
    } else {
      document.getElementById('file-tabs').innerHTML =
        '<div style="padding: var(--spacing-lg); color: var(--text-muted);">Aucun fichier</div>';
      document.getElementById('file-viewer').innerHTML =
        '<div class="empty-state"><div class="empty-state-title">Aucun fichier</div></div>';
    }
  } catch (err) {
    console.error('Error rendering files:', err);
    document.getElementById('file-tabs').innerHTML = '';
    document.getElementById('file-viewer').innerHTML =
      '<div class="empty-state" style="min-height: 200px;"><div class="empty-state-title">Erreur d\'affichage fichiers</div></div>';
  }

  // Source section
  try {
    if (detail.sourceInfo) {
      renderSourceInfo(detail.sourceInfo);
    } else {
      document.getElementById('source-content').textContent = 'Aucune information disponible';
    }
  } catch (err) {
    console.error('Error rendering source:', err);
    document.getElementById('source-content').textContent = 'Erreur de chargement';
  }

  // Override panel (films/series only)
  try {
    if (type === 'films' || type === 'series') {
      initOverridePanel(type, name, detail);
    }
  } catch (err) {
    console.error('Error rendering override panel:', err);
  }
}

function renderMetadata(metadata, type) {
  const el = document.getElementById('metadata-content');

  if (!metadata || typeof metadata !== 'object') {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-title">Pas de metadata disponible</div></div>';
    return;
  }

  let html = '<div style="display: flex; gap: var(--spacing-xl); flex-wrap: wrap; align-items: flex-start;">';

  // Poster: TMDb uses poster_path, iTunes uses artworkUrl100
  const posterPath = metadata.poster_path || metadata.poster;
  if (posterPath) {
    const posterUrl = posterPath.startsWith('/') ? `/api/images/tmdb/w300${posterPath}` : posterPath;
    html += `<div style="flex-shrink: 0; min-width: 120px;">
      <img src="${escapeHtml(posterUrl)}" alt="Poster" style="width: 120px; height: auto; border-radius: var(--radius-lg);" onerror="this.style.display='none'" />
    </div>`;
  } else if (metadata.artworkUrl100) {
    const artworkUrl = metadata.artworkUrl100.replace('100x100', '300x300');
    html += `<div style="flex-shrink: 0; min-width: 120px;">
      <img src="${escapeHtml(artworkUrl)}" alt="Cover" style="width: 120px; height: auto; border-radius: var(--radius-lg);" onerror="this.style.display='none'" />
    </div>`;
  }

  html += '<div style="flex: 1; min-width: 250px;">';

  // Title: TMDb uses title (movies) or name (TV), iTunes uses trackName/collectionName
  const title = metadata.title || metadata.name || metadata.collectionName || metadata.trackName;
  if (title) {
    html += `<div style="font-size: 18px; font-weight: 600; color: var(--text-primary); margin-bottom: var(--spacing-sm);">${escapeHtml(title)}</div>`;
  }

  // Year: TMDb uses release_date (movies) or first_air_date (TV)
  const dateStr = metadata.release_date || metadata.first_air_date || metadata.year;
  const year = dateStr ? (typeof dateStr === 'string' ? dateStr.substring(0, 4) : dateStr) : null;
  const rating = metadata.vote_average || metadata.rating;

  if (year) {
    html += `<div style="font-size: 14px; color: var(--text-secondary); margin-bottom: var(--spacing-md);">${escapeHtml(String(year))}`;
    if (rating) {
      html += ` &bull; &#11088; ${Number(rating).toFixed(1)}/10`;
    }
    html += `</div>`;
  }

  // Genres: TMDb returns [{id, name}], handle both object and string arrays
  if (metadata.genres && metadata.genres.length > 0) {
    html += `<div style="margin-bottom: var(--spacing-md);">
      ${metadata.genres.map(g => `<span class="badge badge-info">${escapeHtml(typeof g === 'object' ? g.name : g)}</span>`).join('')}
    </div>`;
  }

  if (metadata.overview) {
    html += `<div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-top: var(--spacing-md);">${escapeHtml(metadata.overview).replace(/\n/g, '<br>')}</div>`;
  }

  if (type === 'musiques') {
    const artist = metadata.artistName || metadata.artist;
    const album = metadata.collectionName || metadata.album;
    if (artist) {
      html += `<div style="margin-top: var(--spacing-lg); font-size: 13px;"><strong>Artiste:</strong> ${escapeHtml(artist)}</div>`;
    }
    if (album) {
      html += `<div style="font-size: 13px;"><strong>Album:</strong> ${escapeHtml(album)}</div>`;
    }
  } else {
    // Director: TMDb stores in credits.crew
    const director = metadata.director ||
      (metadata.credits && metadata.credits.crew
        ? (metadata.credits.crew.find(c => c.job === 'Director') || {}).name
        : null);
    if (director) {
      html += `<div style="margin-top: var(--spacing-lg); font-size: 13px;"><strong>Realisateur:</strong> ${escapeHtml(director)}</div>`;
    }

    // Cast: TMDb stores in credits.cast as [{name, ...}]
    const castList = metadata.cast ||
      (metadata.credits && metadata.credits.cast
        ? metadata.credits.cast.slice(0, 5).map(c => c.name)
        : null);
    if (castList && castList.length > 0) {
      const names = castList.slice(0, 5).map(c => typeof c === 'object' ? c.name : c);
      html += `<div style="font-size: 13px;"><strong>Acteurs:</strong> ${escapeHtml(names.join(', '))}${castList.length > 5 ? '...' : ''}</div>`;
    }
  }

  html += '</div></div>';
  el.innerHTML = html;
}

function renderFileTabs(files, type, name) {
  const tabsEl = document.getElementById('file-tabs');
  const viewerEl = document.getElementById('file-viewer');

  const viewableFiles = files.filter(f => {
    const fname = f.name || f;
    return fname.endsWith('.nfo') || fname.endsWith('.txt') || fname.endsWith('.prez') || fname.includes('.prez');
  });

  if (viewableFiles.length === 0) {
    tabsEl.innerHTML = '<div style="padding: var(--spacing-lg); color: var(--text-muted);">Aucun fichier visualisable</div>';
    return;
  }

  const tabs = viewableFiles.map((f, i) => {
    const fname = f.name || f;
    const displayName = fname.includes('.prez') ? 'Prez' : fname.split('.').pop().toUpperCase();
    return `<button class="tab ${i === 0 ? 'active' : ''}" data-file="${encodeURIComponent(fname)}">${displayName}</button>`;
  });

  tabsEl.innerHTML = tabs.join('');

  tabsEl.querySelectorAll('.tab').forEach((tab, idx) => {
    tab.addEventListener('click', async (e) => {
      tabsEl.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const filename = decodeURIComponent(tab.dataset.file);
      try {
        viewerEl.innerHTML = '<div class="empty-state"><div class="spinner spinner-lg"></div></div>';
        const content = await api(`/media/${type}/${encodeURIComponent(name)}/file/${encodeURIComponent(filename)}`);
        const text = typeof content === 'string' ? content : (content.content || JSON.stringify(content, null, 2));
        viewerEl.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
      } catch (err) {
        viewerEl.innerHTML = `<div class="empty-state"><div class="empty-state-title">Erreur: ${escapeHtml(err.message)}</div></div>`;
      }
    });
  });

  if (viewableFiles.length > 0) {
    tabsEl.querySelector('.tab').click();
  }
}

function renderSourceInfo(sourceInfo) {
  const el = document.getElementById('source-content');

  if (!sourceInfo || Object.keys(sourceInfo).length === 0) {
    el.textContent = 'Aucune information disponible';
    return;
  }

  let html = '<div style="display: grid; grid-template-columns: 120px 1fr; gap: var(--spacing-lg); row-gap: var(--spacing-md);">';

  for (const [key, value] of Object.entries(sourceInfo)) {
    const label = key.replace(/([A-Z])/g, ' $1').trim();
    html += `<div style="font-weight: 500;">${escapeHtml(label)}:</div>`;
    html += `<div>${escapeHtml(String(value))}</div>`;
  }

  html += '</div>';
  el.innerHTML = html;
}

async function regenerateItem(type, name) {
  if (!confirm(`Regenerer ${name} ?`)) return;

  const btnEl = document.getElementById('btn-regenerate');
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.innerHTML = '<span class="spinner" style="width: 16px; height: 16px;"></span> En cours...';

  try {
    await api(`/media/${type}/${encodeURIComponent(name)}/regenerate`, { method: 'POST' });
    showToast('Regeneration lancee', 'success');
    setTimeout(() => {
      location.reload();
    }, 1500);
  } catch (err) {
    showToast(err.message, 'error');
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

async function deleteItem(type, name) {
  if (!confirm(`Supprimer tous les artefacts de ${name} ? Cette action est irrevocable.`)) return;

  const btnEl = document.getElementById('btn-delete');
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.innerHTML = '<span class="spinner" style="width: 16px; height: 16px;"></span> Suppression...';

  try {
    await api(`/media/${type}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast('Artefacts supprimes', 'success');
    setTimeout(() => {
      window.location.href = `/media/${type}`;
    }, 1500);
  } catch (err) {
    showToast(err.message, 'error');
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

// ============================================================================
// OVERRIDE PANEL
// ============================================================================

function initOverridePanel(type, name, detail) {
  const panel = document.getElementById('override-panel');
  const input = document.getElementById('override-input');
  const badge = document.getElementById('override-badge');
  const btnSet = document.getElementById('btn-set-override');
  const btnClear = document.getElementById('btn-clear-override');
  const tmdbLink = document.getElementById('tmdb-link');

  panel.style.display = '';

  // Extract current TMDb ID from .txt content
  const currentId = detail.txtContent ? extractTmdbId(detail.txtContent) : null;
  const apiType = type === 'films' ? 'movie' : 'tv';

  if (detail.override) {
    input.value = detail.override.id;
    badge.innerHTML = '<span class="badge badge-info">Override actif</span>';
    btnClear.style.display = '';
    tmdbLink.style.display = '';
    tmdbLink.href = `https://www.themoviedb.org/${apiType}/${detail.override.id}`;
  } else if (currentId) {
    input.placeholder = `Actuel: ${currentId}`;
    tmdbLink.style.display = '';
    tmdbLink.href = `https://www.themoviedb.org/${apiType}/${currentId}`;
  } else {
    badge.innerHTML = '<span class="badge badge-error">TMDb non trouve</span>';
  }

  btnSet.addEventListener('click', () => setOverrideId(type, name, input.value));
  btnClear.addEventListener('click', () => clearOverrideId(type, name));
}

function extractTmdbId(txtContent) {
  const match = txtContent.match(/ID TMDB\s*:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function setOverrideId(type, name, idValue) {
  const id = parseInt(idValue, 10);
  if (!id || id <= 0) {
    showToast('Entrez un ID TMDb valide', 'error');
    return;
  }

  const btnEl = document.getElementById('btn-set-override');
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.innerHTML = '<span class="spinner" style="width: 14px; height: 14px;"></span>';

  try {
    const result = await api(`/media/${type}/${encodeURIComponent(name)}/override-id`, {
      method: 'PUT',
      body: { id }
    });
    const title = result.title ? ` (${result.title})` : '';
    showToast(`Override defini: ${id}${title}`, 'success');
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

async function clearOverrideId(type, name) {
  if (!confirm('Retirer l\'override et revenir a la detection automatique ?')) return;

  const btnEl = document.getElementById('btn-clear-override');
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.innerHTML = '<span class="spinner" style="width: 14px; height: 14px;"></span>';

  try {
    await api(`/media/${type}/${encodeURIComponent(name)}/override-id`, { method: 'DELETE' });
    showToast('Override retire, re-detection en cours', 'success');
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function getMediaIcon(type) {
  const icons = {
    'films': '🎬',
    'series': '📺',
    'musiques': '♪'
  };
  return icons[type] || '📁';
}
