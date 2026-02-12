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

// ---------------------- SOURCE CHANGE DETECTION ----------------------
function saveSourceInfo(srcInfoPath, sourceFiles) {
  const info = sourceFiles.map(f => {
    try {
      const s = fs.statSync(f);
      return { path: f, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return { path: f, size: 0, mtimeMs: 0 };
    }
  });
  try {
    fs.writeFileSync(srcInfoPath, JSON.stringify(info));
  } catch (err) {
    console.error(`⚠️ Impossible d'écrire srcinfo : ${srcInfoPath}`, err.message);
  }
}

function hasSourceChanged(srcInfoPath, sourceFiles) {
  try {
    const stored = JSON.parse(fs.readFileSync(srcInfoPath, 'utf-8'));
    if (stored.length !== sourceFiles.length) return true;
    const storedMap = new Map(stored.map(s => [s.path, s]));
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
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&language=${language}`;
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

  if (
    fs.existsSync(nfo) &&
    fs.existsSync(torrent) &&
    fs.existsSync(txt) &&
    hasCache &&
    (!sourceNfoFile || fs.existsSync(sourceNfoDest))
  ) {
    if (!fs.existsSync(srcInfo)) {
      saveSourceInfo(srcInfo, [file]);
      skipped++;
      console.log(`⏭️ Déjà traité : ${path.basename(file)}`);
      return;
    }
    if (!hasSourceChanged(srcInfo, [file])) {
      skipped++;
      console.log(`⏭️ Déjà traité : ${path.basename(file)}`);
      return;
    }
    console.log(`🔄 Fichier source modifié, retraitement : ${path.basename(file)}`);
    try { fs.unlinkSync(nfo); } catch {}
    try { fs.unlinkSync(torrent); } catch {}
    reprocessed++;
  }

  console.log(`📊 ${label} ${index}/${total} → ${path.basename(file)}`);
  fs.mkdirSync(outDir, { recursive: true });

  if (sourceNfoFile && !fs.existsSync(sourceNfoDest)) {
    fs.copyFileSync(sourceNfoFile, sourceNfoDest);
    console.log(`📋 Source NFO copié : ${path.basename(sourceNfoFile)} → ${name}.source.nfo`);
  }

  if (!fs.existsSync(nfo)) {
    let mediadata = await execAsync('mediainfo', [file]);
    mediadata = mediadata.replace(
      /^(\s*Complete name\s*:\s*).*$/m,
      `$1${path.basename(file)}`
    );
    fs.writeFileSync(nfo, `
============================================================
Release Name : ${nameNoExt}
Added On    : ${new Date().toISOString().replace('T',' ').split('.')[0]}
============================================================

${mediadata}

============================================================
Generated by Mediatorr
============================================================
`.trim());
  }

  if (!fs.existsSync(torrent)) {
    const args = ['create', file, '--output', torrent, '--private'];
    TRACKERS.forEach(t => args.push('--tracker', t));
    await execAsync('mkbrr', args);
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

  saveSourceInfo(srcInfo, [file]);
  processed++;
}

// ---------------------- SERIES META ----------------------
async function createSeriesMeta(outDir, name, videos, tmdbType = 'tv') {
  const nfo = path.join(outDir, `${name}.nfo`);
  const txt = path.join(outDir, `${name}.txt`);
  const videoFile = videos[0];

  if (!fs.existsSync(nfo)) {
    let mediadata = await execAsync('mediainfo', [videoFile]);
    mediadata = mediadata.replace(
      /^(\s*Complete name\s*:\s*).*$/m,
      `$1${path.basename(videoFile)}`
    );
    const totalSize = getTotalSize(videos);
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
  const absVideos = videos.map(v => path.isAbsolute(v) ? v : path.resolve(v));

  if (
    fs.existsSync(torrent) &&
    fs.existsSync(nfo) &&
    fs.existsSync(txt) &&
    hasCache &&
    (!sourceNfoFile || fs.existsSync(sourceNfoDest))
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
    reprocessed++;
  }

  console.log(`📊 Série ${index}/${total} → ${name} (${videos.length} fichiers)`);
  fs.mkdirSync(outDir, { recursive: true });

  if (sourceNfoFile && !fs.existsSync(sourceNfoDest)) {
    fs.copyFileSync(sourceNfoFile, sourceNfoDest);
    console.log(`📋 Source NFO copié : ${path.basename(sourceNfoFile)} → ${name}.source.nfo`);
  }

  await createSeriesMeta(outDir, name, videos, 'tv');

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
  if (
    fs.existsSync(torrent) &&
    fs.existsSync(nfo) &&
    fs.existsSync(txt) &&
    hasITunesCache(g.artist, g.title)
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
    reprocessed++;
  }

  // 📄 NFO
  if (!fs.existsSync(nfo)) {
    let mediadata = await execAsync('mediainfo', [refFile]);
    mediadata = mediadata.replace(
      /^(\s*Complete name\s*:\s*).*$/m,
      `$1${path.basename(refFile)}`
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

  // 📦 TORRENT (fichier OU dossier)
  if (!fs.existsSync(torrent)) {
    const args = ['create', entryPath, '--output', torrent, '--private'];
    TRACKERS.forEach(t => args.push('--tracker', t));
    await execAsync('mkbrr', args);
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
      const patterns = media.sources.flatMap(src =>
        VIDEO_EXT.map(e => `${src}/**/*.${e}`)
      );
      const files = [...new Set(await fg(patterns))];
      let i = 0;
      const total = files.length;

      await runTasks(
        files.map(f => () => processFile(f, media.dest, ++i, total, 'Film', TMDB_TYPE_BY_MEDIA[media.name], media.sources)),
        PARALLEL_JOBS
      );
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
console.log(`⏱️ Temps total        : ${formatDuration(totalTime)}`);
console.log('==============================');
})();