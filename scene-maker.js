#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const qs = require('querystring');
const fg = require('fast-glob');
const stringSimilarity = require('string-similarity');

// ---------------------- CONFIG ----------------------
const DEST_DIR = '/data/torrent';
const CACHE_DIR = '/data/cache_tmdb';
const CACHE_DIR_ITUNES = '/data/cache_itunes';
const FINGERPRINT_FILE = '/data/trackers.fingerprint.sha256';

const ENABLE_FILMS = process.env.ENABLE_FILMS === 'true';
const ENABLE_SERIES = process.env.ENABLE_SERIES === 'true';
const ENABLE_MUSIQUES = process.env.ENABLE_MUSIQUES === 'true';
const ENABLE_PREZ = process.env.ENABLE_PREZ !== 'false';
const FORCE_PREZ = process.env.FORCE_PREZ === 'true';
const PREZ_STYLE = parseInt(process.env.PREZ_STYLE) || 1;

function parseDirs(envVar, defaultDir) {
  const raw = process.env[envVar];
  if (!raw || !raw.trim()) return [defaultDir];
  const dirs = [...new Set(raw.split(',').map(d => d.trim().replace(/\/+$/, '')).filter(Boolean))];
  return dirs.length ? dirs : [defaultDir];
}

const MEDIA_CONFIG = [
  ENABLE_FILMS && {
    name: 'films',
    sources: parseDirs('FILMS_DIRS', '/films'),
    dest: path.join(DEST_DIR, 'films')
  },
  ENABLE_MUSIQUES && {
    name: 'musiques',
    sources: parseDirs('MUSIQUES_DIRS', '/musiques'),
    dest: path.join(DEST_DIR, 'musiques'),
    api: 'itunes'
  },
  ENABLE_SERIES && {
    name: 'series',
    sources: parseDirs('SERIES_DIRS', '/series'),
    dest: path.join(DEST_DIR, 'series')
  }
].filter(Boolean);

const TRACKERS = (process.env.TRACKERS || '')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);
  
const TMDB_TYPE_BY_MEDIA = {
  films: 'movie',
  series: 'tv'
};

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const PARALLEL_JOBS = Math.max(1, parseInt(process.env.PARALLEL_JOBS || '1', 10));
const NEED_TMDB = MEDIA_CONFIG.some(m => m.name === 'films' || m.name === 'series');

if (!TRACKERS.length || !MEDIA_CONFIG.length || (NEED_TMDB && !TMDB_API_KEY)) {
  console.error('❌ Configuration invalide');
  process.exit(1);
}

const VIDEO_EXT = ['mkv','mp4','avi','mov','flv','wmv','m4v'];

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR_ITUNES, { recursive: true });
fs.mkdirSync(DEST_DIR, { recursive: true });
for (const m of MEDIA_CONFIG) {
  fs.mkdirSync(m.dest, { recursive: true });
}

for (const m of MEDIA_CONFIG) {
  console.log(`📂 ${m.name} : ${m.sources.length} source(s) → ${m.sources.join(', ')}`);
  for (const src of m.sources) {
    if (!fs.existsSync(src)) {
      console.warn(`⚠️ Répertoire source introuvable : ${src} (${m.name})`);
    }
  }
}

// ---------------------- FINGERPRINT ----------------------
function computeFingerprint(trackers) {
  return crypto
    .createHash('sha256')
    .update(trackers.slice().sort().join('|'))
    .digest('hex');
}

const currentFingerprint = computeFingerprint(TRACKERS);
const previousFingerprint = fs.existsSync(FINGERPRINT_FILE)
  ? fs.readFileSync(FINGERPRINT_FILE, 'utf8').trim()
  : null;

const TRACKERS_CHANGED = currentFingerprint !== previousFingerprint;
let SHOULD_WRITE_FINGERPRINT = false;

if (TRACKERS_CHANGED) {
  console.log('🔁 Trackers modifiés → mise à jour des torrents existants');
  SHOULD_WRITE_FINGERPRINT = true;
}

// ---------------------- STATS ----------------------
let trackersScanned = 0;
let trackersUpdated = 0;
let trackersSkipped = 0;
let processed = 0;
let skipped = 0;
let reprocessed = 0;
let tmdbFound = 0;
let tmdbMissing = 0;
let itunesFound = 0;
let itunesMissing = 0;
let prezGenerated = 0;
const startTime = Date.now();

// ---------------------- UTIL ----------------------
const safeName = name => name.replace(/ /g, '.');
const cleanTitle = title =>
  String(title || '').replace(/[^a-zA-Z0-9 ]/g, '').trim();

const isVideoFile = f =>
  VIDEO_EXT.includes(path.extname(f).slice(1).toLowerCase());

function findSourceNfo(dir) {
  try {
    const entries = fs.readdirSync(dir);
    const nfo = entries.find(e => e.toLowerCase().endsWith('.nfo'));
    return nfo ? path.join(dir, nfo) : null;
  } catch {
    return null;
  }
}

const EPISODE_RE = /[Ss](\d{1,2})[Ee](\d{1,3})/g;

function extractEpisodeNumbers(filenames) {
  const episodes = new Set();
  const seasons = new Set();
  for (const f of filenames) {
    const base = path.basename(f);
    let match;
    while ((match = EPISODE_RE.exec(base)) !== null) {
      seasons.add(parseInt(match[1], 10));
      episodes.add(`S${match[1]}E${match[2]}`);
    }
    EPISODE_RE.lastIndex = 0;
  }
  return { episodes, seasons };
}

const EPISODE_MARKER_RE = /([Ss]\d{1,2})[Ee]\d{1,3}(?:[-Ee]*\d{1,3})*/;

function toSeasonName(folderName) {
  return folderName.replace(EPISODE_MARKER_RE, '$1');
}

function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
  return (bytes / 1e3).toFixed(2) + ' KB';
}

function getTotalSize(files) {
  let total = 0;
  for (const f of files) {
    try { total += fs.statSync(f).size; } catch {}
  }
  return total;
}

function execAsync(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? resolve(out) : reject(err));
  });
}

async function getTorrentSize(torrentPath) {
  try {
    const output = await execAsync('mkbrr', ['inspect', torrentPath]);
    const match = output.match(/Size:\s+([\d.]+)\s+(B|KiB|MiB|GiB|TiB)/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    const unit = match[2];
    const multipliers = { 'B': 1, 'KiB': 1024, 'MiB': 1024 ** 2, 'GiB': 1024 ** 3, 'TiB': 1024 ** 4 };
    return Math.round(value * (multipliers[unit] || 1));
  } catch { return null; }
}

function hasTMDbCache(cacheName, type = 'movie') {
  const key = `${type}_${safeName(cacheName).toLowerCase()}`;
  const file = path.join(CACHE_DIR, key + '.json');
  return fs.existsSync(file);
}

function hasITunesCache(artist, title) {
  const key = safeName(`${artist}_${title}`).toLowerCase();
  const file = path.join(CACHE_DIR_ITUNES, key + '.json');
  return fs.existsSync(file);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

// ---------------------- PREZ GENERATION ----------------------
function extractMediaInfoFromNfo(nfoPath) {
  try {
    const content = fs.readFileSync(nfoPath, 'utf8');
    const match = content.match(/={60}\n\n([\s\S]*?)\n\n={60}\nGenerated by/);
    return match ? match[1].trim() : content;
  } catch {
    return null;
  }
}

function detectSourceFromName(name) {
  if (!name) return null;
  if (/web[-.]?dl/i.test(name)) return 'WEB-DL';
  if (/webrip/i.test(name)) return 'WEBRip';
  if (/amzn|amazon/i.test(name) && /web/i.test(name)) return 'AMZN WEB-DL';
  if (/nf(?![a-z])|netflix/i.test(name)) return 'NF WEB-DL';
  if (/dsnp|disney\+?/i.test(name)) return 'DSNP WEB-DL';
  if (/atvp|apple\s?tv/i.test(name)) return 'ATVP WEB-DL';
  if (/hmax|hbo\s?max/i.test(name)) return 'HMAX WEB-DL';
  if (/hulu/i.test(name)) return 'HULU WEB-DL';
  if (/pcok|peacock/i.test(name)) return 'PCOK WEB-DL';
  if (/remux/i.test(name)) {
    if (/uhd|2160p/i.test(name)) return 'UHD BLURAY REMUX';
    return 'BLURAY REMUX';
  }
  if (/blu[-.]?ray|bdrip|bd[-.]?rip|brrip|br[-.]?rip/i.test(name)) {
    if (/uhd|2160p/i.test(name)) return 'UHD BLURAY';
    return 'BLURAY';
  }
  if (/hdtv/i.test(name)) return 'HDTV';
  if (/pdtv/i.test(name)) return 'PDTV';
  if (/tvrip/i.test(name)) return 'TVRip';
  if (/dvdrip|dvd[-.]?rip/i.test(name)) return 'DVDRip';
  if (/dvd[-.]?scr/i.test(name)) return 'DVDSCR';
  if (/hdcam/i.test(name)) return 'HDCAM';
  if (/cam[-.]?rip/i.test(name)) return 'CAM';
  if (/ts[-.]?rip|telesync/i.test(name)) return 'TS';
  return null;
}

function detectQualityFromName(name) {
  if (!name) return null;
  if (/2160p|4k|uhd/i.test(name)) return '2160p (4K)';
  if (/1080p/i.test(name)) return '1080p';
  if (/1080i/i.test(name)) return '1080i';
  if (/720p/i.test(name)) return '720p';
  if (/576p/i.test(name)) return '576p';
  if (/480p/i.test(name)) return '480p';
  return null;
}

function detectVideoCodecFromName(name) {
  if (!name) return null;
  if (/x265|h\.?265|hevc/i.test(name)) return 'H.265';
  if (/x264|h\.?264|avc/i.test(name)) return 'H.264';
  if (/xvid/i.test(name)) return 'XviD';
  if (/av1(?![0-9])/i.test(name)) return 'AV1';
  return null;
}

function detectAudioCodecFromName(name) {
  if (!name) return null;
  if (/atmos/i.test(name)) {
    if (/truehd/i.test(name)) return 'TrueHD Atmos';
    if (/ddp|dd\+|e[-.]?ac[-.]?3/i.test(name)) return 'E-AC-3 Atmos';
    return 'Atmos';
  }
  if (/truehd/i.test(name)) return 'TrueHD';
  if (/dts[-.]?hd[-.]?ma/i.test(name)) return 'DTS-HD MA';
  if (/dts[-.]?hd/i.test(name)) return 'DTS-HD';
  if (/dts[-.]?x/i.test(name)) return 'DTS:X';
  if (/dts(?![-.]?hd|[-.]?x)/i.test(name)) return 'DTS';
  if (/ddp|dd\+|e[-.]?ac[-.]?3|eac3/i.test(name)) return 'E-AC-3';
  if (/dd[^\+]|ac[-.]?3|ac3/i.test(name)) return 'AC-3';
  if (/aac/i.test(name)) return 'AAC';
  if (/flac/i.test(name)) return 'FLAC';
  return null;
}

function detectLanguagesFromName(name) {
  if (!name) return null;
  const langs = [];
  if (/vff/i.test(name)) langs.push('🇫🇷 Français (VFF)');
  else if (/vf2/i.test(name)) langs.push('🇫🇷 Français (VF2)');
  else if (/vfq/i.test(name)) langs.push('🇨🇦 Français (VFQ)');
  else if (/vfb/i.test(name)) langs.push('🇧🇪 Français (VFB)');
  else if (/truefrench/i.test(name)) langs.push('🇫🇷 Français (TrueFrench)');
  else if (/vf[fi]?(?![a-z])|french|français/i.test(name)) langs.push('🇫🇷 Français');
  if (/vostfr/i.test(name)) langs.push('🇫🇷 VOSTFR');
  return langs.length > 0 ? langs.join(', ') : null;
}

function langCodeToName(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  const langMap = {
    'french': 'Français', 'fra': 'Français', 'fre': 'Français', 'fr': 'Français',
    'english': 'Anglais', 'eng': 'Anglais', 'en': 'Anglais',
    'german': 'Allemand', 'ger': 'Allemand', 'deu': 'Allemand', 'de': 'Allemand',
    'spanish': 'Espagnol', 'spa': 'Espagnol', 'es': 'Espagnol',
    'italian': 'Italien', 'ita': 'Italien', 'it': 'Italien',
    'japanese': 'Japonais', 'jpn': 'Japonais', 'ja': 'Japonais',
    'korean': 'Coréen', 'kor': 'Coréen', 'ko': 'Coréen',
    'portuguese': 'Portugais', 'por': 'Portugais', 'pt': 'Portugais',
    'russian': 'Russe', 'rus': 'Russe', 'ru': 'Russe',
    'chinese': 'Chinois', 'chi': 'Chinois', 'zho': 'Chinois', 'zh': 'Chinois',
    'arabic': 'Arabe', 'ara': 'Arabe', 'ar': 'Arabe',
    'dutch': 'Néerlandais', 'nld': 'Néerlandais', 'dut': 'Néerlandais', 'nl': 'Néerlandais',
    'polish': 'Polonais', 'pol': 'Polonais', 'pl': 'Polonais',
    'turkish': 'Turc', 'tur': 'Turc', 'tr': 'Turc',
    'hindi': 'Hindi', 'hin': 'Hindi', 'hi': 'Hindi',
    'swedish': 'Suédois', 'swe': 'Suédois', 'sv': 'Suédois',
    'norwegian': 'Norvégien', 'nor': 'Norvégien', 'no': 'Norvégien',
    'danish': 'Danois', 'dan': 'Danois', 'da': 'Danois',
    'finnish': 'Finnois', 'fin': 'Finnois', 'fi': 'Finnois',
    'greek': 'Grec', 'gre': 'Grec', 'ell': 'Grec', 'el': 'Grec',
    'hebrew': 'Hébreu', 'heb': 'Hébreu', 'he': 'Hébreu',
    'hungarian': 'Hongrois', 'hun': 'Hongrois', 'hu': 'Hongrois',
    'romanian': 'Roumain', 'rum': 'Roumain', 'ron': 'Roumain', 'ro': 'Roumain',
    'thai': 'Thaï', 'tha': 'Thaï', 'th': 'Thaï',
    'vietnamese': 'Vietnamien', 'vie': 'Vietnamien', 'vi': 'Vietnamien',
    'indonesian': 'Indonésien', 'ind': 'Indonésien', 'id': 'Indonésien',
    'malay': 'Malais', 'msa': 'Malais', 'may': 'Malais', 'ms': 'Malais',
    'bulgarian': 'Bulgare', 'bul': 'Bulgare', 'bg': 'Bulgare',
    'croatian': 'Croate', 'hrv': 'Croate', 'hr': 'Croate',
    'serbian': 'Serbe', 'srp': 'Serbe', 'sr': 'Serbe',
    'slovak': 'Slovaque', 'slk': 'Slovaque', 'slo': 'Slovaque', 'sk': 'Slovaque',
    'slovenian': 'Slovène', 'slv': 'Slovène', 'sl': 'Slovène',
    'ukrainian': 'Ukrainien', 'ukr': 'Ukrainien', 'uk': 'Ukrainien',
    'catalan': 'Catalan', 'cat': 'Catalan', 'ca': 'Catalan',
    'estonian': 'Estonien', 'est': 'Estonien', 'et': 'Estonien',
    'latvian': 'Letton', 'lav': 'Letton', 'lv': 'Letton',
    'lithuanian': 'Lituanien', 'lit': 'Lituanien', 'lt': 'Lituanien',
    'icelandic': 'Islandais', 'isl': 'Islandais', 'ice': 'Islandais', 'is': 'Islandais',
    'georgian': 'Géorgien', 'kat': 'Géorgien', 'geo': 'Géorgien', 'ka': 'Géorgien',
    'armenian': 'Arménien', 'hye': 'Arménien', 'arm': 'Arménien', 'hy': 'Arménien',
    'persian': 'Persan', 'fas': 'Persan', 'per': 'Persan', 'fa': 'Persan',
    'bengali': 'Bengali', 'ben': 'Bengali', 'bn': 'Bengali',
    'tamil': 'Tamoul', 'tam': 'Tamoul', 'ta': 'Tamoul',
    'telugu': 'Télougou', 'tel': 'Télougou', 'te': 'Télougou',
    'urdu': 'Ourdou', 'urd': 'Ourdou', 'ur': 'Ourdou',
    'tagalog': 'Tagalog', 'tgl': 'Tagalog', 'tl': 'Tagalog',
    'brazilian': 'Brésilien', 'pt-br': 'Brésilien'
  };
  return langMap[c] || (c.charAt(0).toUpperCase() + c.slice(1));
}

function parseAudioTracks(mediainfoRaw) {
  if (!mediainfoRaw) return [];
  const tracks = [];
  const audioRegex = /^Audio(?: #\d+)?\s*\n([\s\S]*?)(?=^(?:Audio|Text|Menu|$)|\n\n\n)/gm;
  let match;
  while ((match = audioRegex.exec(mediainfoRaw)) !== null) {
    const audioBlock = match[1];
    const titleMatch = audioBlock.match(/Title\s*:\s*([^\n]+)/);
    const langMatch = audioBlock.match(/Language\s*:\s*(\w+)/);
    let langName = null;
    let langType = null;
    if (titleMatch) {
      const title = titleMatch[1].trim();
      const typeMatch = title.match(/^(\w{2,3})\s*(VFF|VFQ|VFI|VF2|VO|VOF|VOST|VFB)?(?:\s|:)/i);
      if (typeMatch) {
        langName = langCodeToName(typeMatch[1]);
        if (typeMatch[2]) langType = typeMatch[2].toUpperCase();
      }
    }
    if (!langName && langMatch) {
      langName = langCodeToName(langMatch[1]);
    }
    if (langName) {
      const flag = langFlag(langName, langType);
      const trackInfo = langType ? `${flag} ${langName} (${langType})` : `${flag} ${langName}`;
      if (!tracks.includes(trackInfo)) tracks.push(trackInfo);
    }
  }
  return tracks;
}

function parseSubtitleTracks(mediainfoRaw) {
  if (!mediainfoRaw) return [];
  const langTypes = new Map();
  const textRegex = /^Text(?: #\d+)?\s*\n([\s\S]*?)(?=^(?:Audio|Video|Text|Menu|$)|\n\n\n)/gm;
  let match;
  while ((match = textRegex.exec(mediainfoRaw)) !== null) {
    const textBlock = match[1];
    const titleMatch = textBlock.match(/Title\s*:\s*([^\n]+)/);
    const langMatch = textBlock.match(/Language\s*:\s*(\w+)/);
    const forcedMatch = textBlock.match(/Forced\s*:\s*(\w+)/);
    let langName = null;
    let subType = null;
    if (langMatch) langName = langCodeToName(langMatch[1]);
    if (titleMatch) {
      const title = titleMatch[1].trim().toLowerCase();
      if (title.includes('forced') || title.includes('forcé')) subType = 'Forcé';
      else if (title.includes('full') || title.includes('complet')) subType = 'Full';
      else if (title.includes('sdh') || title.includes('cc')) subType = 'SDH';
    }
    if (!subType && forcedMatch && forcedMatch[1].toLowerCase() === 'yes') subType = 'Forcé';
    if (langName) {
      if (!langTypes.has(langName)) langTypes.set(langName, new Set());
      if (subType) langTypes.get(langName).add(subType);
    }
  }
  const result = [];
  for (const [lang, types] of langTypes) {
    const flag = langFlag(lang);
    if (types.size === 0) {
      result.push(`${flag} ${lang}`);
    } else {
      const sortedTypes = [...types].sort((a, b) => {
        const order = { 'Forcé': 0, 'Full': 1, 'SDH': 2 };
        return (order[a] ?? 99) - (order[b] ?? 99);
      });
      result.push(`${flag} ${lang} ${sortedTypes.join('/')}`);
    }
  }
  return result;
}

function parseNfoTechnical(mediainfoRaw, releaseName) {
  const info = {
    source: 'N/A', quality: 'N/A', format: 'N/A',
    videoCodec: 'N/A', bitrate: 'N/A', bitDepth: 'N/A', audioCodec: 'N/A',
    languages: 'N/A', subtitles: 'N/A'
  };

  if (releaseName) {
    const s = detectSourceFromName(releaseName);
    if (s) info.source = s;
    const q = detectQualityFromName(releaseName);
    if (q) info.quality = q;
    const vc = detectVideoCodecFromName(releaseName);
    if (vc) info.videoCodec = vc;
    const ac = detectAudioCodecFromName(releaseName);
    if (ac) info.audioCodec = ac;
    const l = detectLanguagesFromName(releaseName);
    if (l) info.languages = l;
  }

  if (!mediainfoRaw) return info;

  const formatMatch = mediainfoRaw.match(/Format\s*:\s*(\w+)/);
  if (formatMatch) info.format = formatMatch[1].toUpperCase();

  const videoSection = mediainfoRaw.match(/^Video\s*$/m);
  if (videoSection) {
    const videoStart = videoSection.index;
    const nextSection = mediainfoRaw.substring(videoStart).match(/^(Audio|Text|Menu)/m);
    const videoEnd = nextSection ? videoStart + nextSection.index : mediainfoRaw.length;
    const videoBlock = mediainfoRaw.substring(videoStart, videoEnd);

    if (info.quality === 'N/A') {
      const widthMatch = videoBlock.match(/Width\s*:\s*([\d\s]+)\s*pixels/);
      if (widthMatch) {
        const width = parseInt(widthMatch[1].replace(/\s/g, ''));
        if (width >= 3800) info.quality = '2160p (4K)';
        else if (width >= 1900) info.quality = '1080p';
        else if (width >= 1200) info.quality = '720p';
        else info.quality = 'SD';
      }
    }

    if (info.videoCodec === 'N/A') {
      const codecMatch = videoBlock.match(/Format\s*:\s*(\w+)/);
      if (codecMatch) {
        const codec = codecMatch[1].toUpperCase();
        if (codec === 'AVC') info.videoCodec = 'H.264';
        else if (codec === 'HEVC') info.videoCodec = 'H.265';
        else info.videoCodec = codec;
      }
    }

    const bitrateMatch = videoBlock.match(/Bit rate\s*:\s*([^\n]+)/);
    if (bitrateMatch) info.bitrate = bitrateMatch[1].trim();

    const bitDepthMatch = videoBlock.match(/Bit depth\s*:\s*(\d+)\s*bits/);
    if (bitDepthMatch) info.bitDepth = `${bitDepthMatch[1]} bits`;
  }

  if (info.audioCodec === 'N/A') {
    const audioMatch = mediainfoRaw.match(/^Audio[\s\S]*?Format\s*:\s*([\w\-]+)/m);
    if (audioMatch) {
      const codec = audioMatch[1].toUpperCase();
      if (codec === 'AAC') info.audioCodec = 'AAC';
      else if (codec === 'AC-3' || codec === 'AC3') info.audioCodec = 'AC-3';
      else if (codec === 'E-AC-3' || codec === 'EAC3') info.audioCodec = 'E-AC-3';
      else if (codec === 'DTS') info.audioCodec = 'DTS';
      else if (codec === 'TRUEHD' || codec === 'MLP') info.audioCodec = 'TrueHD';
      else if (codec === 'FLAC') info.audioCodec = 'FLAC';
      else info.audioCodec = codec;
    }
  }

  const audioTracks = parseAudioTracks(mediainfoRaw);
  if (audioTracks.length > 0) {
    info.languages = audioTracks.join(', ');
  } else if (info.languages === 'N/A') {
    const audioLangs = [...mediainfoRaw.matchAll(/^Audio[\s\S]*?Language\s*:\s*(\w+)/gm)];
    if (audioLangs.length) {
      const langs = [...new Set(audioLangs.map(m => {
        const name = langCodeToName(m[1]);
        const flag = langFlag(name);
        return `${flag} ${name}`;
      }))];
      info.languages = langs.join(', ');
    }
  }

  const subtitleTracks = parseSubtitleTracks(mediainfoRaw);
  if (subtitleTracks.length > 0) {
    info.subtitles = subtitleTracks.join(', ');
  } else {
    const textLangs = [...mediainfoRaw.matchAll(/^Text[\s\S]*?Language\s*:\s*(\w+)/gm)];
    if (textLangs.length) {
      const subs = [...new Set(textLangs.map(m => {
        const name = langCodeToName(m[1]);
        const flag = langFlag(name);
        return `${flag} ${name}`;
      }))];
      info.subtitles = subs.join(', ');
    }
  }

  if (info.source === 'N/A') {
    const nameMatch = mediainfoRaw.match(/Complete name\s*:\s*([^\n]+)/);
    if (nameMatch) {
      const n = nameMatch[1].toLowerCase();
      if (n.includes('bluray') || n.includes('bdrip')) info.source = 'BLURAY';
      else if (n.includes('webrip') || n.includes('web-dl') || n.includes('webdl')) info.source = 'WEB-DL';
      else if (n.includes('hdtv')) info.source = 'HDTV';
      else if (n.includes('dvd')) info.source = 'DVD';
    }
  }

  return info;
}

function escapeBBCode(str) {
  if (!str) return str;
  return String(str).replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

const LANG_TO_COUNTRY = {
  'Français': 'FR', 'Anglais': 'GB', 'Allemand': 'DE', 'Espagnol': 'ES',
  'Italien': 'IT', 'Japonais': 'JP', 'Coréen': 'KR', 'Portugais': 'PT',
  'Russe': 'RU', 'Chinois': 'CN', 'Arabe': 'SA', 'Néerlandais': 'NL',
  'Polonais': 'PL', 'Turc': 'TR', 'Hindi': 'IN', 'Suédois': 'SE',
  'Norvégien': 'NO', 'Danois': 'DK', 'Finnois': 'FI', 'Grec': 'GR',
  'Hongrois': 'HU', 'Roumain': 'RO', 'Tchèque': 'CZ', 'Hébreu': 'IL',
  'Thaï': 'TH', 'Vietnamien': 'VN', 'Indonésien': 'ID', 'Malais': 'MY',
  'Bulgare': 'BG', 'Croate': 'HR', 'Serbe': 'RS', 'Slovaque': 'SK',
  'Slovène': 'SI', 'Ukrainien': 'UA', 'Catalan': 'ES', 'Basque': 'ES',
  'Estonien': 'EE', 'Letton': 'LV', 'Lituanien': 'LT', 'Islandais': 'IS',
  'Géorgien': 'GE', 'Arménien': 'AM', 'Persan': 'IR', 'Bengali': 'BD',
  'Tamoul': 'LK', 'Télougou': 'IN', 'Ourdou': 'PK', 'Tagalog': 'PH',
  'Brésilien': 'BR'
};

function countryToFlag(countryCode) {
  return [...countryCode.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}

const VARIANT_COUNTRY = {
  'VFQ': 'CA', 'VFB': 'BE'
};

function langFlag(langName, variant) {
  if (variant) {
    const vc = VARIANT_COUNTRY[variant];
    if (vc) return countryToFlag(vc);
  }
  const cc = LANG_TO_COUNTRY[langName];
  return cc ? countryToFlag(cc) : '🏳️';
}

const CODEC_SHORT = {
  'E-AC-3': 'EAC3', 'AC-3': 'AC3', 'TrueHD': 'TrueHD',
  'TrueHD Atmos': 'TrueHD Atmos', 'E-AC-3 Atmos': 'EAC3 Atmos',
  'DTS-HD MA': 'DTS-HD MA', 'DTS-HD': 'DTS-HD', 'DTS': 'DTS',
  'DTS:X': 'DTS:X', 'AAC': 'AAC', 'HE-AAC': 'HE-AAC',
  'FLAC': 'FLAC', 'Atmos': 'Atmos'
};

// ---------------------- PREZ DATA PARSERS ----------------------

function parseAudioTracksRaw(mediainfoRaw) {
  if (!mediainfoRaw) return [];
  const tracks = [];
  const audioRegex = /^Audio(?: #\d+)?\s*\n([\s\S]*?)(?=^(?:Audio|Text|Menu|$)|\n\n\n)/gm;
  let match;
  while ((match = audioRegex.exec(mediainfoRaw)) !== null) {
    const block = match[1];
    const langMatch = block.match(/Language\s*:\s*(\w+)/);
    const titleMatch = block.match(/Title\s*:\s*([^\n]+)/);
    const formatMatch = block.match(/Format\s*:\s*([^\n]+)/);
    const channelsMatch = block.match(/Channel\(s\)\s*:\s*(\d+)/);
    const bitrateMatch = block.match(/Bit rate\s*:\s*([^\n]+)/);

    let langName = langMatch ? langCodeToName(langMatch[1]) : null;
    let langType = null;
    if (titleMatch) {
      const t = titleMatch[1].trim();
      const tm = t.match(/^(\w{2,3})\s*(VFF|VFQ|VFI|VF2|VO|VOF|VOST|VFB)?(?:\s|:)/i);
      if (tm) {
        langName = langCodeToName(tm[1]);
        if (tm[2]) langType = tm[2].toUpperCase();
      }
    }
    if (!langName) continue;

    const channels = channelsMatch ? (parseInt(channelsMatch[1]) > 2 ? `${channelsMatch[1] - 1}.1` : '2.0') : '';
    let codec = formatMatch ? formatMatch[1].trim().split('\n')[0].trim() : null;
    if (codec === 'MLP FBA' || codec === 'MLP FBA 16-ch') codec = 'TrueHD';
    const codecName = codec ? (CODEC_SHORT[codec] || codec) : '';
    const bitrate = bitrateMatch ? bitrateMatch[1].trim() : '';
    const flag = langFlag(langName, langType);
    const typeStr = langType ? ` (${langType})` : '';

    tracks.push({ flag, langName, langType, typeStr, channels, codec: codecName, bitrate });
  }
  return tracks;
}

function formatAudioTrack(t) {
  const codecStr = t.codec ? ` (${t.codec})` : '';
  const bitrateStr = t.bitrate ? ` • ${t.bitrate}` : '';
  return `${t.flag} ${t.langName}${t.typeStr} • ${t.channels}${codecStr}${bitrateStr}`;
}

function parseDetailedAudioTracks(mediainfoRaw) {
  return parseAudioTracksRaw(mediainfoRaw).map(formatAudioTrack);
}

function parseSubtitleTracksRaw(mediainfoRaw) {
  if (!mediainfoRaw) return [];
  const subs = [];
  const textRegex = /^Text(?: #\d+)?\s*\n([\s\S]*?)(?=^(?:Audio|Video|Text|Menu|$)|\n\n\n)/gm;
  let match;
  while ((match = textRegex.exec(mediainfoRaw)) !== null) {
    const block = match[1];
    const langMatch = block.match(/Language\s*:\s*(\w+)/);
    const titleMatch = block.match(/Title\s*:\s*([^\n]+)/);
    const forcedMatch = block.match(/Forced\s*:\s*(\w+)/);
    const formatMatch = block.match(/Format\s*:\s*([^\n]+)/);
    if (!langMatch) continue;
    const langName = langCodeToName(langMatch[1]);
    const flag = langFlag(langName);

    let qualifier = '';
    if (titleMatch) {
      const t = titleMatch[1].trim().toLowerCase();
      if (t.includes('forced') || t.includes('forcé')) qualifier = ' forcés';
      else if (t.includes('full') || t.includes('complet')) qualifier = ' complets';
      else if (t.includes('sdh') || t.includes('cc')) qualifier = ' SDH';
    }
    if (!qualifier && forcedMatch && forcedMatch[1].toLowerCase() === 'yes') qualifier = ' forcés';

    let format = '';
    if (formatMatch) {
      const f = formatMatch[1].trim().split('\n')[0].trim().toUpperCase();
      if (f === 'UTF-8' || f === 'SUBRIP') format = 'SRT';
      else if (f === 'ASS') format = 'ASS';
      else if (f === 'SSA') format = 'SSA';
      else if (f === 'PGS') format = 'PGS';
      else if (f === 'VOBSUB') format = 'VobSub';
      else format = f;
    }

    subs.push({ flag, langName, qualifier, format });
  }
  return subs;
}

function formatSubtitleTrack(s) {
  const fmt = s.format ? ` (${s.format})` : '';
  return `${s.flag} ${s.langName}${s.qualifier}${fmt}`;
}

function formatDetailedSubtitles(mediainfoRaw) {
  return parseSubtitleTracksRaw(mediainfoRaw).map(formatSubtitleTrack);
}

// ---------------------- PREZ COMMON DATA ----------------------

function extractPrezData(nfoContent, mediaType, releaseName) {
  const tech = parseNfoTechnical(nfoContent, releaseName);
  const audioRaw = parseAudioTracksRaw(nfoContent);
  const subsRaw = parseSubtitleTracksRaw(nfoContent);
  const audioFormatted = audioRaw.map(formatAudioTrack);
  const subsFormatted = subsRaw.map(formatSubtitleTrack);

  let codecLabel = tech.videoCodec;
  if (codecLabel === 'H.265') codecLabel = 'x265';
  else if (codecLabel === 'H.264') codecLabel = 'x264';

  let qualityLabel = tech.quality;
  if (qualityLabel.includes('1080')) qualityLabel = `HD ${qualityLabel}`;
  else if (qualityLabel.includes('2160') || qualityLabel.includes('4K')) qualityLabel = `UHD ${qualityLabel}`;

  const firstAudio = audioRaw[0] || null;
  const audioLabel = firstAudio ? [firstAudio.codec, firstAudio.channels].filter(Boolean).join(' ') : '';

  return { tech, audioRaw, subsRaw, audioFormatted, subsFormatted, codecLabel, qualityLabel, audioLabel, firstAudio, mediaType };
}

// ---------------------- PREZ STYLES ----------------------

// Style 1: Badges + Grid Cards
function prezStyle1(d) {
  let bb = '';
  if (d.mediaType !== 'musique') {
    const badges = [];
    if (d.tech.videoCodec !== 'N/A') badges.push(`[badge=red][size=15]${d.codecLabel}[/size][/badge]`);
    if (d.tech.bitDepth !== 'N/A') badges.push(`[badge=gray][size=15]${d.tech.bitDepth}[/size][/badge]`);
    if (d.tech.quality !== 'N/A') badges.push(`[badge=blue][size=15]${d.qualityLabel}[/size][/badge]`);
    if (d.audioLabel) badges.push(`[badge=purple][size=15]${d.audioLabel}[/size][/badge]`);
    bb += badges.join('');
  } else {
    if (d.tech.audioCodec !== 'N/A') bb += `[badge=purple][size=15]${d.tech.audioCodec}[/size][/badge]`;
  }
  bb += '\n\n';
  if (d.audioFormatted.length || d.subsFormatted.length) {
    bb += '[grid]\n';
    if (d.audioFormatted.length) {
      bb += '[col]\n[card]\n';
      bb += '[card-title][size=25][b]🔊 Langues[/b][/size][/card-title]\n';
      bb += '[card-body]\n\n[list]\n';
      bb += d.audioFormatted.map(t => `[*]${t}`).join('\n') + '\n';
      bb += '[/list]\n\n[/card-body]\n[/card]\n[/col]\n';
    }
    if (d.subsFormatted.length) {
      bb += '\n[col]\n[card]\n';
      bb += '[card-title][size=25][b]📝 Sous-titres[/b][/size][/card-title]\n';
      bb += '[card-body]\n\n[list]\n';
      bb += d.subsFormatted.map(s => `[*]${s}`).join('\n') + '\n';
      bb += '[/list]\n\n[/card-body]\n[/card]\n[/col]\n';
    }
    bb += '[/grid]\n';
  }
  return bb;
}

// Style 2: Horizontal Compact (colored text + hr + lists)
function prezStyle2(d) {
  let bb = '';
  if (d.mediaType !== 'musique') {
    const parts = [];
    if (d.tech.videoCodec !== 'N/A') parts.push(`[color=#e74c3c][b]${d.codecLabel}[/b][/color]`);
    if (d.tech.bitDepth !== 'N/A') parts.push(`[color=#95a5a6][b]${d.tech.bitDepth}[/b][/color]`);
    if (d.tech.quality !== 'N/A') parts.push(`[color=#3498db][b]${d.qualityLabel}[/b][/color]`);
    if (d.audioLabel) parts.push(`[color=#9b59b6][b]${d.audioLabel}[/b][/color]`);
    bb += `[center][size=11]${parts.join(' · ')}[/size][/center]\n\n[hr]\n\n`;
  } else {
    if (d.tech.audioCodec !== 'N/A') bb += `[center][size=11][color=#9b59b6][b]${d.tech.audioCodec}[/b][/color][/size][/center]\n\n[hr]\n\n`;
  }
  if (d.audioFormatted.length) {
    bb += `[size=14][color=#3498db][b]🔊 LANGUES[/b][/color][/size]\n`;
    bb += '[list]\n' + d.audioFormatted.map(t => `[*]${t}`).join('\n') + '\n[/list]\n\n';
  }
  if (d.subsFormatted.length) {
    bb += `[size=14][color=#3498db][b]📝 SOUS-TITRES[/b][/color][/size]\n`;
    bb += '[list]\n' + d.subsFormatted.map(s => `[*]${s}`).join('\n') + '\n[/list]\n';
  }
  return bb;
}

// Style 3: Cards with Colored Headers (two-line audio format)
function prezStyle3(d) {
  let bb = '';
  if (d.mediaType !== 'musique') {
    bb += '[card]\n';
    bb += `[card-title][color=#e74c3c][size=18][b]Technique[/b][/size][/color][/card-title]\n`;
    bb += '[card-body]\n';
    const badges = [];
    if (d.tech.videoCodec !== 'N/A') badges.push(`[badge=red][size=13]${d.codecLabel}[/size][/badge]`);
    if (d.tech.bitDepth !== 'N/A') badges.push(`[badge=gray][size=13]${d.tech.bitDepth}[/size][/badge]`);
    if (d.tech.quality !== 'N/A') badges.push(`[badge=blue][size=13]${d.qualityLabel}[/size][/badge]`);
    bb += badges.join(' ') + '\n';
    bb += '[/card-body]\n[/card]\n\n';
  }
  bb += '[grid]\n';
  if (d.audioRaw.length) {
    bb += '[col]\n[card]\n';
    bb += `[card-title][color=#2ecc71][size=18][b]🔊 Audio[/b][/size][/color][/card-title]\n`;
    bb += '[card-body]\n';
    bb += d.audioRaw.map(t => {
      const details = [t.codec, t.channels, t.bitrate].filter(Boolean).join(' • ');
      return `${t.flag} ${t.langName}${t.typeStr}\n[size=11][color=#7f8c8d]${details}[/color][/size]`;
    }).join('\n\n') + '\n';
    bb += '[/card-body]\n[/card]\n[/col]\n';
  }
  if (d.subsRaw.length) {
    bb += '\n[col]\n[card]\n';
    bb += `[card-title][color=#f39c12][size=18][b]📝 Sous-titres[/b][/size][/color][/card-title]\n`;
    bb += '[card-body]\n';
    bb += d.subsRaw.map(s => {
      const fmt = s.format ? `\n[size=11][color=#7f8c8d]${s.format}[/color][/size]` : '';
      return `${s.flag} ${s.langName}${s.qualifier}${fmt}`;
    }).join('\n\n') + '\n';
    bb += '[/card-body]\n[/card]\n[/col]\n';
  }
  bb += '[/grid]\n';
  return bb;
}

// Style 4: Badges + Table
function prezStyle4(d) {
  let bb = '';
  if (d.mediaType !== 'musique') {
    const badges = [];
    if (d.tech.videoCodec !== 'N/A') badges.push(`[badge=red][size=15]${d.codecLabel}[/size][/badge]`);
    if (d.tech.bitDepth !== 'N/A') badges.push(`[badge=gray][size=15]${d.tech.bitDepth}[/size][/badge]`);
    if (d.tech.quality !== 'N/A') badges.push(`[badge=blue][size=15]${d.qualityLabel}[/size][/badge]`);
    if (d.audioLabel) badges.push(`[badge=purple][size=15]${d.audioLabel}[/size][/badge]`);
    bb += `[center]\n${badges.join(' ')}\n[/center]\n\n`;
  } else {
    if (d.tech.audioCodec !== 'N/A') bb += `[center]\n[badge=purple][size=15]${d.tech.audioCodec}[/size][/badge]\n[/center]\n\n`;
  }
  bb += '[table]\n[tr]\n';
  bb += `[td][b][color=#3d85c6][size=14]🔊 Langues[/size][/color][/b][/td]\n`;
  bb += `[td][b][color=#3d85c6][size=14]📝 Sous-titres[/size][/color][/b][/td]\n`;
  bb += '[/tr]\n[tr]\n[td]\n';
  bb += d.audioFormatted.join('\n') + '\n';
  bb += '[/td]\n[td]\n';
  bb += (d.subsFormatted.length ? d.subsFormatted.join('\n') : 'Aucun') + '\n';
  bb += '[/td]\n[/tr]\n[/table]\n';
  return bb;
}

// Style 5: Ultra Minimal (everything on few lines)
function prezStyle5(d) {
  let bb = '';
  if (d.mediaType !== 'musique') {
    const parts = [];
    if (d.tech.videoCodec !== 'N/A') parts.push(`[color=#e74c3c][b]${d.codecLabel}[/b][/color]`);
    if (d.tech.bitDepth !== 'N/A') parts.push(`[color=#95a5a6][b]${d.tech.bitDepth}[/b][/color]`);
    if (d.tech.quality !== 'N/A') parts.push(`[color=#3498db][b]${d.qualityLabel}[/b][/color]`);
    if (d.audioLabel) parts.push(`[color=#9b59b6][b]${d.audioLabel}[/b][/color]`);
    bb += parts.join(' | ') + '\n\n';
  } else {
    if (d.tech.audioCodec !== 'N/A') bb += `[color=#9b59b6][b]${d.tech.audioCodec}[/b][/color]\n\n`;
  }
  if (d.audioRaw.length) {
    const langs = d.audioRaw.map(t => `${t.flag} ${t.langType || t.langName}`).join(' • ');
    const codec = d.audioRaw[0].codec;
    const channels = d.audioRaw[0].channels;
    const bitrate = d.audioRaw[0].bitrate;
    const details = [codec, channels, bitrate ? `@ ${bitrate}` : ''].filter(Boolean).join(' ');
    bb += `[b]🔊[/b] ${langs} — ${details}\n`;
  }
  if (d.subsRaw.length) {
    const subs = d.subsRaw.map(s => `${s.flag} ${s.qualifier.trim() || s.langName}`).join(' • ');
    const fmt = d.subsRaw[0].format || '';
    bb += `[b]📝[/b] ${subs}${fmt ? ` — ${fmt}` : ''}\n`;
  }
  return bb;
}

// Style 6: Badges + Quote Blocks
function prezStyle6(d) {
  let bb = '';
  if (d.mediaType !== 'musique') {
    const badges = [];
    if (d.tech.videoCodec !== 'N/A') badges.push(`[badge=red][size=15]${d.codecLabel}[/size][/badge]`);
    if (d.tech.bitDepth !== 'N/A') badges.push(`[badge=gray][size=15]${d.tech.bitDepth}[/size][/badge]`);
    if (d.tech.quality !== 'N/A') badges.push(`[badge=blue][size=15]${d.qualityLabel}[/size][/badge]`);
    if (d.audioLabel) badges.push(`[badge=purple][size=15]${d.audioLabel}[/size][/badge]`);
    bb += badges.join('') + '\n\n';
  } else {
    if (d.tech.audioCodec !== 'N/A') bb += `[badge=purple][size=15]${d.tech.audioCodec}[/size][/badge]\n\n`;
  }
  if (d.audioFormatted.length) {
    bb += `[size=16][b]🔊 Langues[/b][/size]\n`;
    bb += '[quote]\n' + d.audioFormatted.join('\n') + '\n[/quote]\n\n';
  }
  if (d.subsFormatted.length) {
    bb += `[size=16][b]📝 Sous-titres[/b][/size]\n`;
    bb += '[quote]\n' + d.subsFormatted.join('\n') + '\n[/quote]\n';
  }
  return bb;
}

const PREZ_STYLES = { 1: prezStyle1, 2: prezStyle2, 3: prezStyle3, 4: prezStyle4, 5: prezStyle5, 6: prezStyle6 };

function generateSimplePrez(nfoContent, mediaType, releaseName) {
  const data = extractPrezData(nfoContent, mediaType, releaseName);
  const styleFn = PREZ_STYLES[PREZ_STYLE] || prezStyle1;
  return styleFn(data);
}

function getDirTotalSize(dirPath) {
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirTotalSize(full);
    } else {
      try { total += fs.statSync(full).size; } catch {}
    }
  }
  return total;
}

function getSourceSize(sourcePath) {
  try {
    const stat = fs.statSync(sourcePath);
    return stat.isDirectory() ? getDirTotalSize(sourcePath) : stat.size;
  } catch { return 0; }
}

function generatePrez(type, name, outDir, nfoPath) {
  if (!ENABLE_PREZ) return;
  const prezPath = path.join(outDir, `${name}.prez.txt`);
  if (fs.existsSync(prezPath) && !FORCE_PREZ) return;

  const nfoContent = extractMediaInfoFromNfo(nfoPath);
  const bbcode = generateSimplePrez(nfoContent, type, name);

  if (bbcode) {
    fs.writeFileSync(prezPath, bbcode);
    prezGenerated++;
    console.log(`   📜 Prez générée : ${name}.prez.txt`);
  }
}

// ---------------------- SOURCE CHANGE DETECTION ----------------------
function saveSourceInfo(srcInfoPath, sourceFiles, type = null) {
  const files = sourceFiles.map(f => {
    try {
      const s = fs.statSync(f);
      return { path: f, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return { path: f, size: 0, mtimeMs: 0 };
    }
  });
  const info = type ? { type, files } : files;
  try {
    fs.writeFileSync(srcInfoPath, JSON.stringify(info));
  } catch (err) {
    console.error(`⚠️ Impossible d'écrire srcinfo : ${srcInfoPath}`, err.message);
  }
}

function hasSourceChanged(srcInfoPath, sourceFiles, expectedType = null) {
  try {
    const raw = JSON.parse(fs.readFileSync(srcInfoPath, 'utf-8'));
    let storedFiles;
    let storedType;
    if (Array.isArray(raw)) {
      storedFiles = raw;
      storedType = 'file';
    } else {
      storedType = raw.type || 'file';
      storedFiles = raw.files || [];
    }
    if (expectedType && storedType !== expectedType) return true;
    if (storedFiles.length !== sourceFiles.length) return true;
    const storedMap = new Map(storedFiles.map(s => [s.path, s]));
    for (const f of sourceFiles) {
      const s = fs.statSync(f);
      const prev = storedMap.get(f);
      if (!prev || prev.size !== s.size || prev.mtimeMs !== s.mtimeMs) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ---------------------- TORRENT MODIFY ----------------------
async function modifyTorrentTrackers(torrentPath) {
  const outputPath = torrentPath.replace(/\.torrent$/, '');

  const args = [
    'modify',
    torrentPath
  ];

  TRACKERS.forEach(t => args.push('--tracker', t));

  args.push('--output', outputPath);

  await execAsync('mkbrr', args);
  trackersUpdated++;
  console.log(`   ✅ ${path.basename(torrentPath)}`);
}

// ---------------------- UPDATE EXISTING TORRENTS ----------------------
async function updateAllTorrentsIfNeeded() {
  if (!TRACKERS_CHANGED) return;

  const torrents = await fg(`${DEST_DIR}/**/*.torrent`);
  trackersScanned = torrents.length;

  if (!torrents.length) {
    console.log('ℹ️ Aucun torrent existant à mettre à jour');
    return;
  }

  console.log(`🛠️ Mise à jour announce sur ${torrents.length} torrents`);

await runTasks(
  torrents.map(t => async () => {
    try {
      await modifyTorrentTrackers(t);
    } catch (err) {
      trackersSkipped++;
      console.error('❌ Échec modification torrent :', t);
      console.error(String(err));
    }
  }),
  PARALLEL_JOBS
);
}

// ---------------------- TMDB ----------------------
async function runPythonGuessit(filePath) {
  try {
    const out = await execAsync('python3', ['-c', `
import json
from guessit import guessit
f = guessit("${filePath}")
print(json.dumps({'title': f.get('title',''), 'artist': f.get('artist',''), 'year': f.get('year','')}))
    `]);
    return JSON.parse(out);
  } catch {
    return { title: path.parse(filePath).name, year: '' };
  }
}

async function searchTMDb(title, year, language, type = 'movie') {
  const query = qs.escape(cleanTitle(title));
  const url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${query}&language=${language}`;
  try {
    const res = await axios.get(url);
    return res.data.results?.[0] || null;
  } catch {
    return null;
  }
}

async function getCachedMovie(
  cacheName,
  title,
  year,
  language = 'fr-FR',
  type = 'movie'
) {
  const key = `${type}_${safeName(cacheName).toLowerCase()}`;
  const file = path.join(CACHE_DIR, key + '.json');

  // ✅ cache présent → tentative de lecture
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      console.log(`♻️ Cache TMDb corrompu, recréation : ${file}`);
      fs.unlinkSync(file);
    }
}

  // 🔎 search FR → EN
  let search = await searchTMDb(title, year, language, type);
  if (!search) {
    search = await searchTMDb(title, year, 'en-US', type);
  }
  if (!search?.id) return null;

  // 📥 details FR → EN
  let details = await getTMDbDetails(search.id, language, type);
  if (!details) {
    details = await getTMDbDetails(search.id, 'en-US', type);
  }
  if (!details) return null;

  fs.writeFileSync(file, JSON.stringify(details, null, 2));
  return details;
}
  
  async function getTMDbDetails(id, language, type = 'movie') {
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&language=${language}&append_to_response=credits`;
  try {
    const res = await axios.get(url);
    return res.data;
  } catch {
    return null;
  }
}

async function getTMDbSeasonDetails(tvId, seasonNumber, language = 'fr-FR') {
  const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}&language=${language}`;
  try {
    const res = await axios.get(url);
    return res.data;
  } catch {
    return null;
  }
}

async function getTMDbEpisodeDetails(tvId, seasonNumber, episodeNumber, language = 'fr-FR') {
  const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNumber}/episode/${episodeNumber}?api_key=${TMDB_API_KEY}&language=${language}`;
  try {
    const res = await axios.get(url);
    return res.data;
  } catch {
    return null;
  }
}

// Guessit/API/Cache > Musiques
async function runGuessitMusic(file) {
  const g = await runPythonGuessit(file);
  return {
    artist: g.artist || '',
    title: g.title || path.parse(file).name,
    year: g.year || ''
  };
}

async function searchITunes(term) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=1`;
  try {
    const res = await axios.get(url);
    return res.data.results?.[0] || null;
  } catch {
    return null;
  }
}

async function getCachedMusic(artist, title) {
  const key = safeName(`${artist}_${title}`).toLowerCase();
  const file = path.join(CACHE_DIR_ITUNES, key + '.json');

  // ✅ cache présent → tentative de lecture
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      console.log(`♻️ Cache iTunes corrompu, recréation : ${file}`);
      fs.unlinkSync(file);
    }
  }

  const term = artist ? `${artist} ${title}` : title;
  const data = await searchITunes(term);
  if (!data) return null;

  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

// ---------------------- PROCESS FILE ----------------------
async function processFile(file, destBase, index, total, label, tmdbType = 'movie', sourceDirs = []) {
  const nameNoExt = path.parse(file).name;
  const name = safeName(nameNoExt);
  const outDir = path.join(destBase, name);
  const nfo = path.join(outDir, `${name}.nfo`);
  const torrent = path.join(outDir, `${name}.torrent`);
  const txt = path.join(outDir, `${name}.txt`);

  const hasCache = hasTMDbCache(name, tmdbType);
  const srcInfo = path.join(outDir, `${name}.srcinfo`);
  const fileDir = path.resolve(path.dirname(file));
  const isInSubfolder = sourceDirs.length > 0 && !sourceDirs.some(s => path.resolve(s) === fileDir);
  const sourceNfoFile = isInSubfolder ? findSourceNfo(fileDir) : null;
  const sourceNfoDest = isInSubfolder ? path.join(outDir, `${name}.source.nfo`) : null;

  const prez = path.join(outDir, `${name}.prez.txt`);

  if (
    fs.existsSync(nfo) &&
    fs.existsSync(torrent) &&
    fs.existsSync(txt) &&
    hasCache &&
    (!sourceNfoFile || fs.existsSync(sourceNfoDest)) &&
    (!ENABLE_PREZ || (fs.existsSync(prez) && !FORCE_PREZ))
  ) {
    if (!fs.existsSync(srcInfo)) {
      saveSourceInfo(srcInfo, [file], 'file');
      skipped++;
      console.log(`⏭️ Déjà traité : ${path.basename(file)}`);
      return;
    }
    if (!hasSourceChanged(srcInfo, [file], 'file')) {
      skipped++;
      console.log(`⏭️ Déjà traité : ${path.basename(file)}`);
      return;
    }
    console.log(`🔄 Fichier source modifié, retraitement : ${path.basename(file)}`);
    try { fs.unlinkSync(nfo); } catch {}
    try { fs.unlinkSync(torrent); } catch {}
    try { fs.unlinkSync(prez); } catch {}
    reprocessed++;
  }

  console.log(`📊 ${label} ${index}/${total} → ${path.basename(file)}`);
  fs.mkdirSync(outDir, { recursive: true });

  if (sourceNfoFile && !fs.existsSync(sourceNfoDest)) {
    fs.copyFileSync(sourceNfoFile, sourceNfoDest);
    console.log(`📋 Source NFO copié : ${path.basename(sourceNfoFile)} → ${name}.source.nfo`);
  }

  if (!fs.existsSync(torrent)) {
    const args = ['create', file, '--output', torrent, '--private'];
    TRACKERS.forEach(t => args.push('--tracker', t));
    await execAsync('mkbrr', args);
  }

  const torrentSize = await getTorrentSize(torrent);

  if (!fs.existsSync(nfo)) {
    let mediadata = await execAsync('mediainfo', [file]);
    mediadata = mediadata.replace(
      /^(\s*Complete name\s*:\s*).*$/m,
      `$1${path.basename(file)}`
    );
    const sizeLine = torrentSize ? `\nTotal Size  : ${formatSize(torrentSize)}` : '';
    fs.writeFileSync(nfo, `
============================================================
Release Name : ${nameNoExt}
Added On    : ${new Date().toISOString().replace('T',' ').split('.')[0]}${sizeLine}
============================================================

${mediadata}

============================================================
Generated by Mediatorr
============================================================
`.trim());
  }

  if (!fs.existsSync(txt) || !hasTMDbCache(name, tmdbType)) {
    const g = await runPythonGuessit(file);
    const m = await getCachedMovie(name, g.title, g.year, 'fr-FR', tmdbType);
    if (m?.id) {
      tmdbFound++;
      fs.writeFileSync(txt, `ID TMDB : ${m.id}`);
    } else {
      tmdbMissing++;
      fs.writeFileSync(txt, 'TMDB not found');
      console.log(`⚠️ TMDb non trouvé : ${g.title}`);
    }
  }

  // 📜 Prez BBCode
  if (ENABLE_PREZ && (!fs.existsSync(prez) || FORCE_PREZ)) {
    generatePrez(tmdbType === 'tv' ? 'serie' : 'film', name, outDir, nfo);
  }

  saveSourceInfo(srcInfo, [file], 'file');
  processed++;
}

// ---------------------- FILM FOLDER ----------------------
async function processFilmFolder(folder, destBase, index, total, sourceDirs = []) {
  const videos = await fg(VIDEO_EXT.map(e => `${folder}/**/*.${e}`));
  if (!videos.length) return;

  const name = safeName(path.basename(folder));
  const outDir = path.join(destBase, name);
  const torrent = path.join(outDir, `${name}.torrent`);
  const nfo = path.join(outDir, `${name}.nfo`);
  const txt = path.join(outDir, `${name}.txt`);
  const hasCache = hasTMDbCache(name, 'movie');
  const sourceNfoFile = findSourceNfo(folder);
  const sourceNfoDest = path.join(outDir, `${name}.source.nfo`);
  const srcInfo = path.join(outDir, `${name}.srcinfo`);
  const prez = path.join(outDir, `${name}.prez.txt`);
  const absVideos = videos.map(v => path.isAbsolute(v) ? v : path.resolve(v));
  const videoFile = absVideos[0];

  if (
    fs.existsSync(torrent) &&
    fs.existsSync(nfo) &&
    fs.existsSync(txt) &&
    hasCache &&
    (!sourceNfoFile || fs.existsSync(sourceNfoDest)) &&
    (!ENABLE_PREZ || (fs.existsSync(prez) && !FORCE_PREZ))
  ) {
    if (!fs.existsSync(srcInfo)) {
      saveSourceInfo(srcInfo, absVideos, 'folder');
      skipped++;
      console.log(`⏭️ Déjà traité (dossier film) : ${name}`);
      return;
    }
    if (!hasSourceChanged(srcInfo, absVideos, 'folder')) {
      skipped++;
      console.log(`⏭️ Déjà traité (dossier film) : ${name}`);
      return;
    }
    console.log(`🔄 Source modifié, retraitement dossier film : ${name}`);
    try { fs.unlinkSync(nfo); } catch {}
    try { fs.unlinkSync(torrent); } catch {}
    try { fs.unlinkSync(prez); } catch {}
    reprocessed++;
  }

  console.log(`📊 Film ${index}/${total} → ${name} (dossier, ${videos.length} vidéo(s))`);
  fs.mkdirSync(outDir, { recursive: true });

  if (sourceNfoFile && !fs.existsSync(sourceNfoDest)) {
    fs.copyFileSync(sourceNfoFile, sourceNfoDest);
    console.log(`📋 Source NFO copié : ${path.basename(sourceNfoFile)} → ${name}.source.nfo`);
  }

  if (!fs.existsSync(nfo)) {
    let mediadata = await execAsync('mediainfo', [videoFile]);
    mediadata = mediadata.replace(
      /^(\s*Complete name\s*:\s*).*$/m,
      `$1${path.basename(videoFile)}`
    );
    fs.writeFileSync(nfo, `
============================================================
Release Name : ${name}
Added On    : ${new Date().toISOString().replace('T',' ').split('.')[0]}
============================================================

${mediadata}

============================================================
Generated by Mediatorr
============================================================
`.trim());
  }

  if (!fs.existsSync(torrent)) {
    const args = ['create', folder, '--output', torrent, '--private'];
    TRACKERS.forEach(t => args.push('--tracker', t));
    await execAsync('mkbrr', args);
  }

  const torrentSize = await getTorrentSize(torrent);

  if (!fs.existsSync(txt) || !hasTMDbCache(name, 'movie')) {
    const g = await runPythonGuessit(videoFile);
    const m = await getCachedMovie(name, g.title, g.year, 'fr-FR', 'movie');
    if (m?.id) {
      tmdbFound++;
      fs.writeFileSync(txt, `ID TMDB : ${m.id}`);
    } else {
      tmdbMissing++;
      fs.writeFileSync(txt, 'TMDB not found');
      console.log(`⚠️ TMDb non trouvé : ${g.title}`);
    }
  }

  // 📜 Prez BBCode
  if (ENABLE_PREZ && (!fs.existsSync(prez) || FORCE_PREZ)) {
    generatePrez('film', name, outDir, nfo);
  }

  saveSourceInfo(srcInfo, absVideos, 'folder');
  processed++;
}

// ---------------------- SERIES META ----------------------
async function createSeriesMeta(outDir, name, videos, tmdbType = 'tv', folder = null, torrentSize = null) {
  const nfo = path.join(outDir, `${name}.nfo`);
  const txt = path.join(outDir, `${name}.txt`);
  const videoFile = videos[0];

  if (!fs.existsSync(nfo)) {
    let mediadata = await execAsync('mediainfo', [videoFile]);
    mediadata = mediadata.replace(
      /^(\s*Complete name\s*:\s*).*$/m,
      `$1${path.basename(videoFile)}`
    );
    const totalSize = torrentSize || getTotalSize(videos);
    fs.writeFileSync(nfo, `
============================================================
Release Name : ${name}
Added On    : ${new Date().toISOString().replace('T',' ').split('.')[0]}
Files       : ${videos.length}
Total Size  : ${formatSize(totalSize)}
============================================================

${mediadata}

============================================================
Generated by Mediatorr
============================================================
`.trim());
  }

  if (!fs.existsSync(txt) || !hasTMDbCache(name, tmdbType)) {
    const g = await runPythonGuessit(videoFile);
    const m = await getCachedMovie(name, g.title, g.year, 'fr-FR', tmdbType);
    if (m?.id) {
      tmdbFound++;
      fs.writeFileSync(txt, `ID TMDB : ${m.id}`);
    } else {
      tmdbMissing++;
      fs.writeFileSync(txt, 'TMDB not found');
      console.log(`⚠️ TMDb non trouvé (série) : ${g.title}`);
    }
  }

  // 📜 Prez BBCode
  const prezSerie = path.join(outDir, `${name}.prez.txt`);
  if (ENABLE_PREZ && (!fs.existsSync(prezSerie) || FORCE_PREZ)) {
    generatePrez('serie', name, outDir, nfo);
  }
}

// ---------------------- SERIES FOLDER ----------------------
async function processSeriesFolder(folder, destBase, index, total) {
  const videos = await fg(VIDEO_EXT.map(e => `${folder}/**/*.${e}`));
  if (!videos.length) return;

  const rawName = safeName(path.basename(folder));
  const { episodes, seasons } = extractEpisodeNumbers(videos);
  const isSeason = videos.length > 1 && episodes.size > 1 && seasons.size === 1;
  const name = isSeason ? toSeasonName(rawName) : rawName;
  if (isSeason) {
    console.log(`  📁 Saison détectée (${episodes.size} épisodes) → ${name}`);
  }
  const outDir = path.join(destBase, name);
  const torrent = path.join(outDir, `${name}.torrent`);
  const nfo = path.join(outDir, `${name}.nfo`);
  const txt = path.join(outDir, `${name}.txt`);
  const hasCache = hasTMDbCache(name, 'tv');
  const sourceNfoFile = findSourceNfo(folder);
  const sourceNfoDest = path.join(outDir, `${name}.source.nfo`);
  const srcInfo = path.join(outDir, `${name}.srcinfo`);
  const prezSeries = path.join(outDir, `${name}.prez.txt`);
  const absVideos = videos.map(v => path.isAbsolute(v) ? v : path.resolve(v));

  if (
    fs.existsSync(torrent) &&
    fs.existsSync(nfo) &&
    fs.existsSync(txt) &&
    hasCache &&
    (!sourceNfoFile || fs.existsSync(sourceNfoDest)) &&
    (!ENABLE_PREZ || (fs.existsSync(prezSeries) && !FORCE_PREZ))
  ) {
    if (!fs.existsSync(srcInfo)) {
      saveSourceInfo(srcInfo, absVideos);
      skipped++;
      console.log(`⏭️ Déjà traité (dossier complet) : ${name}`);
      return;
    }
    if (!hasSourceChanged(srcInfo, absVideos)) {
      skipped++;
      console.log(`⏭️ Déjà traité (dossier complet) : ${name}`);
      return;
    }
    console.log(`🔄 Source modifié, retraitement dossier : ${name}`);
    try { fs.unlinkSync(nfo); } catch {}
    try { fs.unlinkSync(torrent); } catch {}
    try { fs.unlinkSync(prezSeries); } catch {}
    reprocessed++;
  }

  console.log(`📊 Série ${index}/${total} → ${name} (${videos.length} fichiers)`);
  fs.mkdirSync(outDir, { recursive: true });

  if (sourceNfoFile && !fs.existsSync(sourceNfoDest)) {
    fs.copyFileSync(sourceNfoFile, sourceNfoDest);
    console.log(`📋 Source NFO copié : ${path.basename(sourceNfoFile)} → ${name}.source.nfo`);
  }

  if (!fs.existsSync(torrent)) {
    const args = [
      'create',
      folder,
      '--output', torrent,
      '--private'
    ];

    TRACKERS.forEach(t => args.push('--tracker', t));

    await execAsync('mkbrr', args);
  }

  const torrentSize = await getTorrentSize(torrent);

  await createSeriesMeta(outDir, name, videos, 'tv', folder, torrentSize);

  saveSourceInfo(srcInfo, absVideos);
  processed++;
}

// ---------------------- MUSIC FOLDER ----------------------
const AUDIO_EXT = ['mp3', 'flac', 'aac', 'wav'];

function isAudioFile(f) {
  return AUDIO_EXT.includes(path.extname(f).slice(1).toLowerCase());
}

async function hasPartialFiles(root) {
  const files = await fg(
    ['**/*.part', '**/*.tmp', '**/*.crdownload'],
    { cwd: root, onlyFiles: true }
  );
  return files.length > 0;
}

async function findFirstAudioFile(root) {
  const stat = fs.statSync(root);

  if (stat.isFile() && isAudioFile(root)) {
    return root;
  }

  if (!stat.isDirectory()) {
    return null;
  }

  const files = await fg(
    AUDIO_EXT.map(e => `**/*.${e}`),
    {
      cwd: root,
      onlyFiles: true,
      caseSensitiveMatch: false
    }
  );

  return files.length ? path.join(root, files.sort()[0]) : null;
}

async function findAllAudioFiles(root) {
  const stat = fs.statSync(root);
  if (stat.isFile()) return isAudioFile(root) ? [root] : [];
  if (!stat.isDirectory()) return [];
  const files = await fg(
    AUDIO_EXT.map(e => `**/*.${e}`),
    { cwd: root, onlyFiles: true, caseSensitiveMatch: false }
  );
  return files.sort().map(f => path.join(root, f));
}

async function processMusicEntry(entryPath, destBase, index, total) {
  if (!fs.existsSync(entryPath)) return;
  entryPath = path.resolve(entryPath);

  if (fs.statSync(entryPath).isDirectory()) {
    if (await hasPartialFiles(entryPath)) {
      console.log(`⏸️ Téléchargement en cours, skip : ${entryPath}`);
      return;
    }
  }

  const name = safeName(path.basename(entryPath));
  const outDir = path.join(destBase, name);

  const torrent = path.join(outDir, `${name}.torrent`);
  const nfo = path.join(outDir, `${name}.nfo`);
  const txt = path.join(outDir, `${name}.txt`);

  console.log(`🎵 Musique ${index}/${total} → ${name}`);
  fs.mkdirSync(outDir, { recursive: true });

  // 🎯 Trouver le premier fichier audio (peu importe la profondeur)
  const refFile = await findFirstAudioFile(entryPath);

  if (!refFile) {
    console.log(`⚠️ Aucun fichier audio trouvé : ${entryPath}`);
    return;
  }

  // 🎯 Guessit AVANT toute décision
  const g = await runGuessitMusic(refFile);
  const allAudio = await findAllAudioFiles(entryPath);
  const srcInfo = path.join(outDir, `${name}.srcinfo`);

  // ⏭️ Skip uniquement si TOUT existe + cache iTunes OK
  const prezMusic = path.join(outDir, `${name}.prez.txt`);
  if (
    fs.existsSync(torrent) &&
    fs.existsSync(nfo) &&
    fs.existsSync(txt) &&
    hasITunesCache(g.artist, g.title) &&
    (!ENABLE_PREZ || (fs.existsSync(prezMusic) && !FORCE_PREZ))
  ) {
    if (!fs.existsSync(srcInfo)) {
      saveSourceInfo(srcInfo, allAudio);
      skipped++;
      console.log(`⏭️ Déjà traité (musique) : ${name}`);
      return;
    }
    if (!hasSourceChanged(srcInfo, allAudio)) {
      skipped++;
      console.log(`⏭️ Déjà traité (musique) : ${name}`);
      return;
    }
    console.log(`🔄 Source modifié, retraitement musique : ${name}`);
    try { fs.unlinkSync(nfo); } catch {}
    try { fs.unlinkSync(torrent); } catch {}
    try { fs.unlinkSync(prezMusic); } catch {}
    reprocessed++;
  }

  // 📦 TORRENT (fichier OU dossier)
  if (!fs.existsSync(torrent)) {
    const args = ['create', entryPath, '--output', torrent, '--private'];
    TRACKERS.forEach(t => args.push('--tracker', t));
    await execAsync('mkbrr', args);
  }

  const torrentSize = await getTorrentSize(torrent);

  // 📄 NFO
  if (!fs.existsSync(nfo)) {
    let mediadata = await execAsync('mediainfo', [refFile]);
    mediadata = mediadata.replace(
      /^(\s*Complete name\s*:\s*).*$/m,
      `$1${path.basename(refFile)}`
    );
    const sizeLine = torrentSize ? `\nTotal Size  : ${formatSize(torrentSize)}` : '';
    fs.writeFileSync(nfo, `
============================================================
Release Name : ${name}
Added On    : ${new Date().toISOString().replace('T',' ').split('.')[0]}${sizeLine}
============================================================

${mediadata}

============================================================
Generated by Mediatorr
============================================================
`.trim());
  }

  // 🎶 iTunes
  if (!fs.existsSync(txt) || !hasITunesCache(g.artist, g.title)) {
    const m = await getCachedMusic(g.artist, g.title);

    if (m) {
      itunesFound++;
      fs.writeFileSync(
        txt,
        `iTunes ID : ${m.collectionId || m.trackId}`
      );
    } else {
      itunesMissing++;
      fs.writeFileSync(txt, 'iTunes not found');
    }
  }

  // 📜 Prez BBCode
  if (ENABLE_PREZ && (!fs.existsSync(prezMusic) || FORCE_PREZ)) {
    generatePrez('musique', name, outDir, nfo);
  }

  saveSourceInfo(srcInfo, allAudio);
  processed++;
}

// ---------------------- PARALLEL ----------------------
async function runTasks(tasks, limit) {
  const running = new Set();
  for (const t of tasks) {
    const p = t();
    running.add(p);
    p.finally(() => running.delete(p));
    if (running.size >= limit) await Promise.race(running);
  }
  await Promise.all(running);
}

// ---------------------- MAIN ----------------------
(async () => {
  console.log('🚀 Scan initial au démarrage');
  
    // UPDATE TRACKERS AVANT TOUT
  await updateAllTorrentsIfNeeded();
  
  if (SHOULD_WRITE_FINGERPRINT) {
    fs.writeFileSync(FINGERPRINT_FILE, currentFingerprint);
  }

  for (const media of MEDIA_CONFIG) {

    console.log(
      PARALLEL_JOBS === 1
        ? `▶️ ${media.name} : mode séquentiel`
        : `⚡ ${media.name} : mode parallèle (${PARALLEL_JOBS} jobs)`
    );

    if (media.name === 'films') {
      const tasks = [];
      const allEntries = [];

      for (const src of media.sources) {
        if (!fs.existsSync(src)) continue;
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const e of entries) {
          allEntries.push({ entry: e, source: src });
        }
      }

      let i = 0;
      const total = allEntries.length;

      for (const { entry: e, source: src } of allEntries) {
        const full = path.join(src, e.name);

        if (e.isFile() && isVideoFile(e.name)) {
          tasks.push(() =>
            processFile(full, media.dest, ++i, total, 'Film', TMDB_TYPE_BY_MEDIA[media.name], media.sources)
          );
        }

        if (e.isDirectory()) {
          tasks.push(() =>
            processFilmFolder(full, media.dest, ++i, total, media.sources)
          );
        }
      }

      if (!tasks.length) {
        console.log('ℹ️ Aucun contenu film à traiter');
        continue;
      }

      await runTasks(tasks, PARALLEL_JOBS);
    }

    if (media.name === 'series') {
      const tasks = [];
      const allEntries = [];

      for (const src of media.sources) {
        if (!fs.existsSync(src)) continue;
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const e of entries) {
          allEntries.push({ entry: e, source: src });
        }
      }

      let i = 0;
      const total = allEntries.length;

      for (const { entry: e, source: src } of allEntries) {
        const full = path.join(src, e.name);

        if (e.isFile() && isVideoFile(e.name)) {
          tasks.push(() =>
            processFile(full, media.dest, ++i, total, 'Série fichier', TMDB_TYPE_BY_MEDIA[media.name], media.sources)
          );
        }

        if (e.isDirectory()) {
          tasks.push(() =>
            processSeriesFolder(full, media.dest, ++i, total)
          );
        }
      }

      if (!tasks.length) {
        console.log('ℹ️ Aucun contenu série à traiter');
        continue;
      }

      await runTasks(tasks, PARALLEL_JOBS);
    }
	
	if (media.name === 'musiques') {
  const allEntries = [];
  for (const src of media.sources) {
    if (!fs.existsSync(src)) continue;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const e of entries) {
      allEntries.push({ entry: e, source: src });
    }
  }

  let i = 0;
  const total = allEntries.length;

  const tasks = allEntries.map(({ entry: e, source: src }) => () =>
    processMusicEntry(
      path.join(src, e.name),
      media.dest,
      ++i,
      total
    )
  );

  await runTasks(tasks, PARALLEL_JOBS);
}

  }

  const totalTime = Date.now() - startTime;

console.log('\n📊 Résumé final');
console.log('==============================');

if (TRACKERS_CHANGED) {
  console.log('🛠️ Mise à jour announce');
  console.log(`   🔍 Torrents analysés : ${trackersScanned}`);
  console.log(`   🔁 Torrents modifiés : ${trackersUpdated}`);
  console.log(`   ⏭️ Torrents ignorés  : ${trackersSkipped}`);
  console.log('------------------------------');
}

console.log(`🎞️ Traités           : ${processed}`);
console.log(`🔄 Retraités (modif) : ${reprocessed}`);
console.log(`⏭️ Déjà existants     : ${skipped}`);
console.log(`🎬 TMDb trouvés       : ${tmdbFound}`);
console.log(`⚠️ TMDb manquants     : ${tmdbMissing}`);
console.log(`🎵 iTunes trouvés     : ${itunesFound}`);
console.log(`⚠️ iTunes manquants   : ${itunesMissing}`);
console.log(`📜 Prez générées      : ${prezGenerated}`);
console.log(`⏱️ Temps total        : ${formatDuration(totalTime)}`);
console.log('==============================');
})();