# Mediatorr Features

Mediatorr is a Docker-based automation tool that monitors media directories and generates `.torrent`, `.nfo`, and metadata files for films, series, and music. This document outlines all capabilities designed for NAS/seedbox deployments with private trackers.

## Torrent Generation

### Automatic Creation
Mediatorr automatically generates `.torrent` files for all supported media types using the `mkbrr` utility with the private flag, ensuring compatibility with private trackers.

### Multiple Tracker Support
Configure one or more tracker announce URLs via the `TRACKERS` environment variable (comma-separated). The tool handles tracker management automatically:
- Computes a SHA256 fingerprint of all configured trackers on startup
- Detects tracker configuration changes between runs
- Batch-updates all existing `.torrent` files when trackers change, without requiring full reprocessing

### Per-Media-Type Organization
- **Films**: One `.torrent` per video file, organized by film name
- **Series**: One `.torrent` per folder (represents entire season or series)
- **Music**: One `.torrent` per album (folder or single file)

## NFO (Metadata) Generation

### Technical Metadata Extraction
Mediatorr uses `mediainfo` to extract comprehensive technical details from media files:
- Video codec, resolution, bitrate, frame rate
- Audio codec, channels, sample rate
- Duration and other technical specifications
- Automatically sanitizes absolute paths (replaces with filenames only)

### Release Header and Footer
Generated `.nfo` files include:
- Release name and generation timestamp
- Full technical details from mediainfo
- For series: file count and total size information

### Source NFO Preservation
If source directories contain existing `.nfo` files, Mediatorr copies them as `{name}.source.nfo`:
- **Films**: Only copies if the video file is in a subfolder (not at source root)
- **Series**: Copies if found at folder root
- Preserves original source metadata for reference

## Metadata Lookup and Caching

### TMDb Integration (Films & Series)
Mediatorr queries The Movie Database API for comprehensive metadata:
- **Language fallback**: Searches French (FR-FR) first, automatically falls back to English (en-US) if not found
- **Retrieved data**: Title, overview, release date, genres, and TMDb ID
- **Films**: Uses movie search endpoint
- **Series**: Uses TV search endpoint
- Persistent local cache prevents redundant API calls

### iTunes Integration (Music)
Music metadata is retrieved from iTunes Search API:
- Searches by artist and title combined
- Stores collection ID or track ID in metadata file
- Persistent local cache with automatic corruption recovery

### Cache Management
- TMDb cache: `/data/cache_tmdb/{type}_{name}.json`
- iTunes cache: `/data/cache_itunes/{artist}_{title}.json`
- Automatically detects and recovers from corrupted cache files
- Persistent across container restarts via `/data` volume

## Real-Time Monitoring

### Continuous Directory Watching
Mediatorr monitors configured media directories in real-time using `inotifywait`:
- Detects `create`, `moved_to`, and `close_write` events
- Triggers processing immediately when new media is added
- Watches recursively across all subdirectories

### Initial Scan
On container startup, Mediatorr performs a full scan of all configured directories before entering real-time monitoring mode. This ensures no existing media is missed.

### Cooldown Mechanism
Configurable scan cooldown (default: 5 seconds, via `SCAN_COOLDOWN` env var) prevents redundant processing when multiple file operations occur in quick succession.

### Error Resilience
Processing errors do not stop the watcher. The tool logs failures and continues monitoring, retrying on the next triggered scan.

## Partial Download Detection

Mediatorr intelligently detects incomplete downloads:
- Recognizes `.part`, `.tmp`, and `.crdownload` file extensions (common for incomplete downloads)
- For music specifically: waits until all partial files are removed before processing
- Ignores partial file events in real-time watchers to avoid premature processing

## Multi-Directory Support

Each media type can monitor multiple source directories, configured via comma-separated environment variables:
- `FILMS_DIRS`: Additional film directories (default: `/films`)
- `SERIES_DIRS`: Additional series directories (default: `/series`)
- `MUSIQUES_DIRS`: Additional music directories (default: `/musiques`)

Example:
```
FILMS_DIRS=/films,/films-4k,/films-archive
SERIES_DIRS=/series,/series-archive
```

All directories are monitored with the same real-time watching and processing rules.

## Smart Season Detection (Series)

For series processing, Mediatorr analyzes video file patterns to distinguish between a single season and a full series:
- Examines episode patterns (S##E## format) across video files in a folder
- If 2 or more distinct episodes and single season detected: marks as season-only release
- Automatically renames output (e.g., from "Show.S01E01-E10" to "Show.S01")
- Falls back to full folder name if season pattern is not detected

This automation prevents misbranding of partial series as complete releases.

## Source Change Detection

Mediatorr tracks source media changes to detect when reprocessing is needed:

### Change Tracking
Stores source file metadata in `.srcinfo` JSON files:
- File path, size in bytes, and modification timestamp
- Created alongside generated artifacts

### Change Detection
On each scan, current file metadata is compared against stored `.srcinfo`:
- Detects file additions, deletions, size changes, and modification time changes
- When changes are detected: existing `.nfo` and `.torrent` are deleted and regenerated

### Migration for Existing Media
If `.srcinfo` is missing for existing processed items (e.g., from previous Mediatorr versions):
- Creates `.srcinfo` from current file state without reprocessing
- Prevents unnecessary regeneration of old media

This ensures artifacts always reflect the current source state without requiring manual intervention.

## Parallel Processing

Mediatorr supports concurrent job execution to improve performance:
- Configured via `PARALLEL_JOBS` environment variable (default: 1)
- Applies to media processing, tracker updates, and other batch operations
- Uses internal concurrency limiter for controlled parallelization
- Useful for systems with multiple processors and adequate I/O bandwidth

## File Format Support

### Video Formats
- mkv, mp4, avi, mov, flv, wmv, m4v

### Audio Formats
- mp3, flac, aac, wav

## Processing Pipeline

### Initialization
1. Container startup: Full scan of all configured directories
2. Tracker fingerprint check: Updates existing torrents if tracker URLs changed
3. Real-time monitoring: Enters continuous directory watching mode

### Per-Item Processing (Films & Series)
1. Check if all artifacts exist (.torrent, .nfo, .txt, API cache, source NFO if applicable, .srcinfo)
2. If complete: skip processing
3. If incomplete or source changed: parse filename via GuessIt (Python-based parsing)
4. Generate `.torrent` file with mkbrr
5. Generate `.nfo` file via mediainfo
6. Copy source `.nfo` if present
7. Query metadata API (TMDb)
8. Cache API response
9. Write metadata `.txt` file

### Music Processing
1. Detect complete album (wait for partial files to complete)
2. Parse filenames via GuessIt before skip check
3. Check if all artifacts exist
4. If complete: skip processing
5. Generate `.torrent`, `.nfo`, and `.txt`
6. Query iTunes API
7. Cache API response

## Statistics and Reporting

Each processing run generates a summary including:
- **Tracker updates**: Number of torrents scanned, modified, and skipped
- **Processing**: New items processed, items reprocessed due to source changes, items skipped (already complete)
- **Metadata**: TMDb/iTunes lookups found and missing
- **Execution time**: Total duration of the run

This information helps monitor tool performance and identify processing issues.

## Docker Image Characteristics

### Build Strategy
- Multi-stage build: Go builder for mkbrr compilation, Node.js 20 Alpine for runtime
- Lightweight Alpine base reduces image size and attack surface
- Pre-compiled `mkbrr` binary optimizes performance

### Architecture Support
- Multi-architecture builds (amd64 primary, arm64 available)
- Native runner builds per architecture for optimal performance
- Manifests pushed to both GHCR and Docker Hub

### User Configuration
- Default: Non-root `node` user for security
- Alternative entrypoint available: `docker-entrypoint.sh` with PUID/PGID mapping for NAS compatibility
- Supports custom user mapping via `PUID` and `PGID` environment variables

## Filename Parsing

Mediatorr uses GuessIt (Python library) for intelligent filename parsing:
- Extracts title, artist, year, and other metadata from filenames
- Handles complex naming conventions in media communities
- Works before skip checks to identify media even without artifacts

## Media Type Processing Differences

### Films
- Per-file processing: each video file generates independent torrent
- Recursive scanning: detects videos in subdirectories
- Metadata: TMDb movie API endpoint
- NFO: Technical specs wrapped with film name and generation date

### Series
- Per-folder processing: entire folder represents one season or series
- Smart season detection: automatically determines series vs season based on episode patterns
- Metadata: TMDb TV API endpoint
- NFO: Includes file count and total folder size

### Music
- Per-album processing: supports folder-based or single-file albums
- Partial download awareness: waits for completion before processing
- Filename parsing: GuessIt runs before skip checks
- Metadata: iTunes API (artist + title search)

## Environment Configuration

All features are controlled via environment variables:

| Variable | Type | Description |
|----------|------|-------------|
| `TRACKERS` | Required | Comma-separated announce URLs |
| `TMDB_API_KEY` | Conditional | TMDb API key (required for films/series) |
| `ENABLE_FILMS` | Required | Toggle films processing (true/false) |
| `ENABLE_SERIES` | Required | Toggle series processing (true/false) |
| `ENABLE_MUSIQUES` | Required | Toggle music processing (true/false) |
| `FILMS_DIRS` | Optional | Comma-separated film directories |
| `SERIES_DIRS` | Optional | Comma-separated series directories |
| `MUSIQUES_DIRS` | Optional | Comma-separated music directories |
| `PARALLEL_JOBS` | Optional | Concurrent processing jobs (default: 1) |
| `SCAN_COOLDOWN` | Optional | Seconds between scans (default: 5) |
| `PUID`/`PGID` | Optional | User/group mapping for Docker |

## Output Organization

All generated files are stored in `/data/torrent/` with the following structure:

```
/data/torrent/
├── films/
│   └── Film.Name/
│       ├── Film.Name.torrent
│       ├── Film.Name.nfo
│       ├── Film.Name.source.nfo
│       ├── Film.Name.txt
│       └── Film.Name.srcinfo
├── series/
│   └── Serie.Name.S01/
│       ├── Serie.Name.S01.torrent
│       ├── Serie.Name.S01.nfo
│       ├── Serie.Name.S01.source.nfo
│       ├── Serie.Name.S01.txt
│       └── Serie.Name.S01.srcinfo
└── musiques/
    └── Album.Name/
        ├── Album.Name.torrent
        ├── Album.Name.nfo
        ├── Album.Name.txt
        └── Album.Name.srcinfo
```

## Summary

Mediatorr automates the complete workflow of torrent creation, metadata enrichment, and artifact management for media files. Its real-time monitoring, intelligent caching, and error handling make it ideal for unattended operation on NAS systems and seedboxes. The modular design supports films, series, and music with type-specific optimizations while maintaining a unified processing pipeline.
