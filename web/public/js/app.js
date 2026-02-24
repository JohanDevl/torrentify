// SSE Connection Manager
const SSE = {
  connection: null,
  listeners: new Map(),
  reconnectTimeout: null,

  connect() {
    this.connection = new EventSource('/api/events');

    this.connection.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      this.emit('status', data);
      updateStatusIndicator(data.state);
    });

    this.connection.addEventListener('scan:progress', (e) => {
      const data = JSON.parse(e.data);
      this.emit('scan:progress', data);
    });

    this.connection.addEventListener('scan:complete', (e) => {
      const data = JSON.parse(e.data);
      this.emit('scan:complete', data);
    });

    this.connection.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      this.emit('log', data);
    });

    this.connection.onerror = () => {
      this.connection.close();
      updateStatusIndicator('error');
      this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
    };
  },

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => callback(data));
    }
  },

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  },

  off(event, callback) {
    if (this.listeners.has(event)) {
      const callbacks = this.listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }
};

// API Helper
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const headers = {};
    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`/api${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('text/plain')) {
      return res.text();
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Timeout: le serveur ne repond pas');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Toast notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const iconMap = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };

  toast.innerHTML = `
    <div class="toast-icon">${iconMap[type] || '•'}</div>
    <div class="toast-content">
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// Theme toggle
function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');

  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
    });
  }
}

// Navigation - highlight active nav link
function initNav() {
  const currentPage = window.location.pathname;
  const pageMap = {
    '/': 'dashboard',
    '/media/films': 'films',
    '/media/series': 'series',
    '/media/musiques': 'musiques',
    '/config': 'config',
    '/logs': 'logs'
  };

  let activeLink = pageMap[currentPage];

  if (!activeLink && currentPage.startsWith('/media/')) {
    const type = currentPage.split('/')[2];
    activeLink = type;
  }

  if (!activeLink) {
    activeLink = 'dashboard';
  }

  document.querySelectorAll('.nav-link').forEach(link => {
    const page = link.getAttribute('data-page');
    link.classList.toggle('active', page === activeLink);
  });

  const headerTitle = document.querySelector('.header-title');
  if (headerTitle) {
    const titles = {
      dashboard: 'Dashboard',
      films: 'Films',
      series: 'Series',
      musiques: 'Musiques',
      config: 'Configuration',
      logs: 'Logs'
    };
    headerTitle.textContent = titles[activeLink] || 'Dashboard';
  }
}

// Status indicator update
function updateStatusIndicator(status) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  if (!dot || !text) return;

  dot.className = 'status-dot';

  const statusMap = {
    idle: { class: 'idle', text: 'Idle' },
    running: { class: '', text: 'Running...' },
    error: { class: 'error', text: 'Error' }
  };

  const config = statusMap[status] || statusMap.idle;
  dot.classList.add(config.class);
  text.textContent = config.text;
}

// Format helpers
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Init on page load
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initNav();
  SSE.connect();
});
