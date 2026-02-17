const fs = require('fs');
const path = require('path');

const CONFIG_FILE = '/data/config.json';
const IMG_BASE_URL = 'https://raw.githubusercontent.com/JohanDevl/mediatorr/main/assets/images';

const DEFAULTS = {
  trackers: [],
  tmdbApiKey: '',
  enableFilms: false,
  enableSeries: false,
  enableMusiques: false,
  enablePrez: true,
  parallelJobs: 1,
  scanCooldown: 5,
  scanSchedule: '',
  filmsDirs: ['/films'],
  seriesDirs: ['/series'],
  musiquesDirs: ['/musiques'],
  prezImages: {
    info: `${IMG_BASE_URL}/info.png`,
    synopsis: `${IMG_BASE_URL}/synopsis.png`,
    movie: `${IMG_BASE_URL}/movie.png`,
    serie: `${IMG_BASE_URL}/serie.png`,
    download: `${IMG_BASE_URL}/download.png`,
    link: `${IMG_BASE_URL}/link.png`
  }
};

function loadConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`Failed to read/parse ${CONFIG_FILE}:`, err.message);
  }
  return {};
}

function parseEnvBoolean(val) {
  return val === 'true' || val === '1';
}

function parseEnvArray(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function parseEnvNumber(val, defaultVal) {
  const num = parseInt(val, 10);
  return isNaN(num) ? defaultVal : num;
}

function getEnvConfig() {
  const env = process.env;

  return {
    trackers: parseEnvArray(env.TRACKERS),
    tmdbApiKey: env.TMDB_API_KEY || '',
    enableFilms: parseEnvBoolean(env.ENABLE_FILMS),
    enableSeries: parseEnvBoolean(env.ENABLE_SERIES),
    enableMusiques: parseEnvBoolean(env.ENABLE_MUSIQUES),
    enablePrez: env.ENABLE_PREZ !== undefined ? parseEnvBoolean(env.ENABLE_PREZ) : DEFAULTS.enablePrez,
    parallelJobs: parseEnvNumber(env.PARALLEL_JOBS, DEFAULTS.parallelJobs),
    scanCooldown: parseEnvNumber(env.SCAN_COOLDOWN, DEFAULTS.scanCooldown),
    scanSchedule: env.SCAN_SCHEDULE || DEFAULTS.scanSchedule,
    filmsDirs: env.FILMS_DIRS ? parseEnvArray(env.FILMS_DIRS) : DEFAULTS.filmsDirs,
    seriesDirs: env.SERIES_DIRS ? parseEnvArray(env.SERIES_DIRS) : DEFAULTS.seriesDirs,
    musiquesDirs: env.MUSIQUES_DIRS ? parseEnvArray(env.MUSIQUES_DIRS) : DEFAULTS.musiquesDirs,
    prezImages: {
      info: env.PREZ_IMG_INFO || DEFAULTS.prezImages.info,
      synopsis: env.PREZ_IMG_SYNOPSIS || DEFAULTS.prezImages.synopsis,
      movie: env.PREZ_IMG_MOVIE || DEFAULTS.prezImages.movie,
      serie: env.PREZ_IMG_SERIE || DEFAULTS.prezImages.serie,
      download: env.PREZ_IMG_DOWNLOAD || DEFAULTS.prezImages.download,
      link: env.PREZ_IMG_LINK || DEFAULTS.prezImages.link
    }
  };
}

function mergeConfigs(fileConfig, envConfig, defaults) {
  const result = {};

  for (const key in defaults) {
    if (fileConfig.hasOwnProperty(key)) {
      result[key] = fileConfig[key];
    } else if (envConfig[key] !== undefined && envConfig[key] !== null && envConfig[key] !== '' && envConfig[key].length > 0) {
      result[key] = envConfig[key];
    } else {
      result[key] = defaults[key];
    }
  }

  return result;
}

function getConfig() {
  const fileConfig = loadConfigFile();
  const envConfig = getEnvConfig();
  return mergeConfigs(fileConfig, envConfig, DEFAULTS);
}

function saveConfig(data) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Failed to write ${CONFIG_FILE}:`, err.message);
    return false;
  }
}

function cfg(key, envKey, defaultVal) {
  const config = getConfig();

  if (config.hasOwnProperty(key)) {
    return config[key];
  }

  if (envKey && process.env[envKey] !== undefined) {
    const envVal = process.env[envKey];
    if (typeof defaultVal === 'boolean') {
      return parseEnvBoolean(envVal);
    }
    if (typeof defaultVal === 'number') {
      return parseEnvNumber(envVal, defaultVal);
    }
    return envVal;
  }

  return defaultVal;
}

module.exports = {
  CONFIG_FILE,
  getConfig,
  saveConfig,
  cfg
};
