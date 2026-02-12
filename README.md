# Mediatorr

**Mediatorr** is a Docker container that automatically generates **.torrent**, **.nfo**, and **TMDb / iTunes** metadata files from **films, series, and music**.

It monitors one or more directories, analyzes filenames, fetches metadata from **TMDb** (films & series) and **iTunes** (music), and prepares clean, ready-to-use files for **private trackers** on **Unraid**, **NAS**, and **seedbox** setups.

---

## Features

- Automatic `.torrent` file generation via mkbrr
- Configurable trackers with automatic update of existing `.torrent` files when URLs change
- NFO file generation with mediainfo (absolute paths sanitized)
- Automatic copy of source NFO files to output directory
- `.txt` file with TMDb/iTunes ID or explicit "not found" message
- Real-time monitoring via inotifywait (create, move, write events)
- Support for multiple source directories per media type (e.g., `/films` + `/films-4k`)
- Automatic initial scan on container startup
- Recursive subdirectory scanning
- Intelligent filename analysis via GuessIt
- TMDb lookup (FR then EN fallback) and iTunes lookup with persistent local cache
- Cache auto-recovery when corrupted or deleted
- Independent activation of films, series, and music
- Automatic season vs full series detection with file count and total size in NFO
- In-progress download detection (`.part`, `.tmp`, `.crdownload`)
- Source file change detection (size/mtime) with automatic reprocessing
- Configurable parallel processing
- Structured output by media type (films / series / music)
- Lightweight Alpine-based Docker image
- Multi-architecture support (amd64 / arm64)

---

## Quick Start

```yaml
services:
  mediatorr:
    image: johandevl/mediatorr:latest
    container_name: mediatorr
    restart: unless-stopped
    user: "1000:1000"
    environment:
      - ENABLE_FILMS=true
      - ENABLE_SERIES=false
      - ENABLE_MUSIQUES=false
      - TMDB_API_KEY=your_tmdb_api_key
      - TRACKERS=https://your-tracker.com/announce
    volumes:
      - /path/to/films:/films
      - /path/to/output:/data
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| TRACKERS | Tracker announce URLs (comma-separated) |
| TMDB_API_KEY | TMDb API key (required if films or series enabled) |

### Media Activation

| Variable | Description |
|----------|-------------|
| ENABLE_FILMS | Enable film processing and monitoring (true/false) |
| ENABLE_SERIES | Enable series processing and monitoring (true/false) |
| ENABLE_MUSIQUES | Enable music processing and monitoring (true/false) |

> At least one of the three must be enabled.

### Source Directories (optional)

| Variable | Description |
|----------|-------------|
| FILMS_DIRS | Film source directories, comma-separated (default: /films) |
| SERIES_DIRS | Series source directories, comma-separated (default: /series) |
| MUSIQUES_DIRS | Music source directories, comma-separated (default: /musiques) |

> Allows monitoring multiple directories per type, e.g., `FILMS_DIRS=/films,/films-4k`

### Optional

| Variable | Description |
|----------|-------------|
| PARALLEL_JOBS | Number of files processed concurrently (default: 1) |
| SCAN_COOLDOWN | Seconds between consecutive scans (default: 5) |
| PUID | User ID for the container process |
| PGID | Group ID for the container process |

---

## Volumes

### Input (media)

| Container Path | Description |
|---------------|-------------|
| /films | Default films directory (configurable via FILMS_DIRS) |
| /series | Default series directory (configurable via SERIES_DIRS) |
| /musiques | Default music directory (configurable via MUSIQUES_DIRS) |

### Output

| Container Path | Description |
|---------------|-------------|
| /data | Generated torrents, NFOs, TXT files, and API caches |

---

## Output Structure

```
/data/
├── torrent/
│   ├── films/
│   │   └── Film.Name/
│   │       ├── Film.Name.torrent
│   │       ├── Film.Name.nfo
│   │       ├── Film.Name.source.nfo    (copy of source NFO if present)
│   │       ├── Film.Name.txt
│   │       └── Film.Name.srcinfo       (source change tracking)
│   ├── series/
│   │   └── Serie.Name.S01/
│   │       ├── Serie.Name.S01.torrent
│   │       ├── Serie.Name.S01.nfo
│   │       ├── Serie.Name.S01.source.nfo
│   │       ├── Serie.Name.S01.txt
│   │       └── Serie.Name.S01.srcinfo
│   └── musiques/
│       └── Album.Name/
│           ├── Album.Name.torrent
│           ├── Album.Name.nfo
│           ├── Album.Name.txt
│           └── Album.Name.srcinfo
├── cache_tmdb/
│   └── *.json
├── cache_itunes/
│   └── *.json
└── trackers.fingerprint.sha256
```

---

## Full docker-compose Example

```yaml
services:
  mediatorr:
    image: johandevl/mediatorr:latest
    container_name: mediatorr
    restart: unless-stopped
    user: "1000:1000"
    environment:
      # Media activation
      - ENABLE_FILMS=true
      - ENABLE_SERIES=false
      - ENABLE_MUSIQUES=true
      # TMDb
      - TMDB_API_KEY=your_tmdb_api_key
      # Trackers (comma-separated)
      - TRACKERS=https://tracker1/announce,https://tracker2/announce
      # Multiple source directories (optional, comma-separated)
      # - FILMS_DIRS=/films,/films-4k
      # - SERIES_DIRS=/series,/series-4k
      # Optional
      - PARALLEL_JOBS=1
    volumes:
      # Input
      - /source/films:/films
      - /source/series:/series
      - /source/musiques:/musiques
      # Additional inputs (uncomment for multi-directory)
      # - /source/films-4k:/films-4k
      # - /source/series-4k:/series-4k
      # Output
      - /destination/torrent:/data
```

---

## Documentation

For more details, see the full documentation:

- [Architecture](docs/architecture.md) -- Technical internals and design
- [Features](docs/features.md) -- Complete feature documentation
- [Installation Guide](docs/installation.md) -- Detailed setup, configuration, and troubleshooting

---

## Tracker Management

On startup, Mediatorr computes a SHA256 fingerprint of the configured tracker URLs. If trackers have changed since the last run, all existing `.torrent` files are automatically updated with the new URLs via `mkbrr modify`.

---

## Notes

- **Films**: one file = one torrent, TMDb lookup
- **Series**: one folder = one torrent, automatic season/series detection, TMDb lookup
- **Music**: one album (folder or file) = one torrent, iTunes lookup, waits for `.part` completion
- Already processed files are never regenerated (unless source changes detected)
- API caches are persistent and auto-repaired
