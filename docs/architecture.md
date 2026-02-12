# Mediatorr Architecture

## Overview

Mediatorr is a Docker-based automation tool that monitors media directories and generates `.torrent`, `.nfo`, and metadata `.txt` files for films, series, and music. Designed for NAS/seedbox deployments (Unraid, etc.) with private trackers.

**Current version**: 1.1.2 (tracked in `VERSION` file)

---

## Project Structure

```
mediatorr/
├── scene-maker.js              # Core processing logic (CommonJS, Node.js 20)
├── watch.sh                    # Entrypoint: initial scan + inotifywait real-time watchers
├── docker-entrypoint.sh        # Alternative entrypoint with PUID/PGID user mapping
├── Dockerfile                  # Multi-stage: Go builder (mkbrr) + Node.js 20 Alpine
├── docker-compose.yml          # Example deployment config
├── package.json                # Dependencies: axios, fast-glob, string-similarity
├── VERSION                     # Semver version (read by CI for image tagging)
├── .dockerignore
├── .github/workflows/
│   ├── docker-publish.yml      # Build & push to GHCR + Docker Hub on push
│   └── auto-tag.yml            # Auto-create git tag when VERSION changes
├── docs/
│   └── architecture.md         # This file
└── README.md
```

---

## Startup Chain

The application follows a strict initialization sequence:

1. **Docker container starts** with `USER node`
2. **watch.sh** runs as entrypoint (or **docker-entrypoint.sh** for PUID/PGID mapping)
3. **scene-maker.js** executes initial scan of all enabled media directories
4. **inotifywait** starts persistent watchers for real-time file monitoring per directory
5. **SCAN_COOLDOWN** mechanism prevents redundant scans during rapid file changes

### watch.sh

Entry point script that orchestrates scanning and real-time monitoring.

**Responsibilities**:
- Runs initial scan: `node /app/scene-maker.js`
- Starts `inotifywait -m -r` watchers for each enabled media type directory
- Monitors file system events: `create`, `moved_to`, `close_write`
- Detects partial downloads: `.part`, `.tmp`, `.crdownload` extensions
- Implements cooldown mechanism to avoid redundant scans (default 5 seconds)
- Error resilient — continues operation on script errors

**Real-time monitoring**:
- Spawns one inotifywait process per media type (if enabled)
- Watches entire directory tree recursively
- Aggregates events within cooldown window to reduce processing overhead
- Triggers full scan of affected media type on file change

### docker-entrypoint.sh

Alternative entrypoint for advanced deployments requiring user/group mapping.

**Features**:
- Maps PUID/PGID environment variables to container user via su-exec
- Creates user/group if they don't exist
- Sets ownership of `/data` and `/app` to mapped user
- Ensures file permissions match host system

---

## Core Processing Engine: scene-maker.js

Single-file CommonJS module (Node.js 20) containing all media processing logic.

### Processing Pipeline

For each enabled media type (films, series, music):

1. **Scan source directories** — glob matching for video/audio files
2. **Skip check** — determine if file has all artifacts and source unchanged
   - Required artifacts: `.torrent`, `.nfo`, `.txt`, API cache entry, `.srcinfo`
   - Optional artifacts: `.source.nfo` (if source NFO exists)
3. **Parse filename** — extract title/artist/year via Python GuessIt
4. **Detect source changes** — compare `.srcinfo` (size, mtime) against current file state
5. **Create .torrent file** — via `mkbrr create` with `--private` flag and configured trackers
6. **Generate .nfo file** — via `mediainfo` with absolute path sanitization
7. **Copy source .nfo** — if present in source directory → `{name}.source.nfo`
8. **Lookup metadata** — TMDb (films/series) or iTunes (music) API
9. **Cache results** — store API responses for future lookups

### Parallel Execution Model

```javascript
runTasks(tasks, concurrency)
```

Utility function that processes tasks with controlled concurrency using `Promise.race()`.

- **Default concurrency**: 1 (serial processing)
- **Configurable via**: `PARALLEL_JOBS` environment variable
- **Use case**: Reduce wall-clock time when processing large media libraries
- **Limitation**: Tracker fingerprinting and torrent modification must complete before parallel media processing begins

### Tracker Fingerprinting System

On startup, computes and caches a SHA256 fingerprint of tracker announce URLs.

**Process**:
1. Sort all tracker URLs alphabetically
2. Join with `|` separator
3. Compute SHA256 hash
4. Store in `/data/trackers.fingerprint.sha256`

**Change detection**:
- If fingerprint differs from previous run, tracker URLs have changed
- Uses `mkbrr modify` to update announce URLs on ALL existing `.torrent` files
- Updates performed in parallel (limited by `PARALLEL_JOBS`)
- Prevents invalid announcements on previously created torrents

### Source Change Detection

Stores per-media source file metadata in `.srcinfo` files (JSON format).

**Srcinfo file format**:
```json
[
  {
    "path": "/films/Movie.Name/Movie.Name.mkv",
    "size": 1234567890,
    "mtimeMs": 1704067200000
  }
]
```

**On each scan**:
1. Load `.srcinfo` if it exists
2. Compare stored metadata (path, size, mtime) against current files
3. If any mismatch (file count change, size change, modification time change):
   - Delete `.nfo` and `.torrent` files
   - Fall through to full regeneration
4. If `.srcinfo` missing on existing media:
   - Create `.srcinfo` from current state
   - Skip reprocessing (avoid unnecessary API calls on migration)

**Benefits**:
- Detects file replacements and size changes automatically
- Enables re-torrent generation if source updates
- Avoids redundant processing on stable files
- Smooth migration path from pre-srcinfo versions

### Cache Management

Metadata is cached locally to reduce API calls and improve performance.

**TMDb Cache** (`/data/cache_tmdb/`):
- File naming: `{type}_{name}.json` (type = `movie` or `tv`)
- Lookup order: FR-FR locale first, falls back to en-US if not found
- Storage: API response object (original structure preserved)
- Corruption handling: Auto-detected on parse failure, bad cache deleted, re-fetch triggered

**iTunes Cache** (`/data/cache_itunes/`):
- File naming: `{artist}_{title}.json`
- Storage: API response object
- Corruption handling: Same as TMDb

**Cache repair**:
- If JSON parse fails, assume cache corrupted
- Delete bad file
- Re-fetch from API in same processing cycle
- Log corruption event for monitoring

---

## Media Type Processing

Each media type has distinct processing logic while following the common pipeline.

### Films

**Scope**: Individual video files within source directories

**Processing**:
- Recursively scan source directories for video files
- Per-file processing (one torrent per file)
- Parse filename via GuessIt to extract title and year
- Look up metadata on TMDb as `movie` type
- Prefer French locale (FR-FR), fall back to English (en-US)
- Output: `{Film.Name}/` directory containing:
  - `.torrent` file
  - `.nfo` metadata file
  - `.txt` metadata file
  - `.source.nfo` (if source NFO exists in source directory)
  - `.srcinfo` source tracking file

**Output path structure**:
```
/data/torrent/films/
└── Film.Name/
    ├── Film.Name.torrent
    ├── Film.Name.nfo
    ├── Film.Name.txt
    ├── Film.Name.source.nfo
    └── Film.Name.srcinfo
```

### Series

**Scope**: Folder-based season or full-series collections

**Processing**:
- Each folder = one torrent (entire series or single season)
- Pattern detection for season vs full series:
  - `S01E01` pattern detected → treat as season (`S01` added to name)
  - No pattern detected → treat as full series
- Parse folder name via GuessIt to extract title and year
- Look up metadata on TMDb as `tv` type
- Prefer French locale (FR-FR), fall back to English (en-US)
- Auto-rename output based on detected season

**Output path structure**:
```
/data/torrent/series/
└── Serie.Name.S01/           # if season detected
    ├── Serie.Name.S01.torrent
    ├── Serie.Name.S01.nfo
    ├── Serie.Name.S01.txt
    ├── Serie.Name.S01.source.nfo
    └── Serie.Name.S01.srcinfo
```

**Episode pattern matching**:
- Pattern: `S\d{2}E\d{2}` (case-insensitive)
- Extracted season number added to folder name in output
- Enables proper season tracking across releases

### Music

**Scope**: Audio files or album folders

**Processing**:
- Album-based processing (folder or single file)
- Waits for download completion: ignores `.part`, `.tmp`, `.crdownload` extensions
- **Critical**: GuessIt parsing runs BEFORE skip check (needed for cache lookup key)
- Parse filename via GuessIt to extract artist and album title
- Look up metadata on iTunes API
- Supports nested audio files within album folders
- Normalizes entry paths with `path.resolve()` for consistent tracking

**Output path structure**:
```
/data/torrent/musiques/
└── Album.Name/
    ├── Album.Name.torrent
    ├── Album.Name.nfo
    ├── Album.Name.txt
    └── Album.Name.srcinfo
```

**Download completion detection**:
- inotifywait monitors close_write event (file close after modification)
- Partial files (ending in `.part`, `.tmp`, `.crdownload`) are skipped
- Once fully written, file enters processing pipeline on next scan

---

## External Tools & Dependencies

### Compiled Tools

**mkbrr** (Go binary):
- Compiled from source in Dockerfile multi-stage build
- Creates torrent files: `mkbrr create --private --announce=<urls>`
- Modifies announce URLs: `mkbrr modify <torrent-file> --announce=<urls>`
- Private flag ensures tracker authentication required
- Single-threaded, spawned per media item

**mediainfo** (system utility):
- Generates media metadata files (NFO format)
- Executed as child process via Node.js `execFile()`
- Output sanitized to remove absolute paths
- Provides technical media information

### Python Tools

**GuessIt** (Python 3, virtual environment in `/opt/venv`):
- Parses media filenames to extract title, artist, year
- Spawned as child process: `python -c "from guessit import guessit; import json; print(json.dumps(guessit(filename)))"`
- Returns JSON structure with parsed metadata
- Installed in isolated virtualenv to avoid system Python conflicts

### System Utilities

**inotify-tools**:
- Real-time file system event monitoring via inotifywait
- Flags: `-m` (monitor), `-r` (recursive)
- Monitored events: `create`, `moved_to`, `close_write`
- One process per enabled media type directory

### Node.js Dependencies

**axios**:
- HTTP client for external API calls
- Used for TMDb and iTunes API requests
- Timeout handling and error resilience built-in

**fast-glob**:
- Recursive file pattern matching
- Returns paths matching glob patterns (video, audio, torrent files)
- Efficient file discovery across nested directories

**string-similarity**:
- String comparison utilities for fuzzy matching
- Available for custom matching logic

---

## Output Directory Structure

```
/data/
├── torrent/
│   ├── films/
│   │   └── Film.Name/
│   │       ├── Film.Name.torrent
│   │       ├── Film.Name.nfo
│   │       ├── Film.Name.source.nfo
│   │       ├── Film.Name.txt
│   │       └── Film.Name.srcinfo
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
│   ├── movie_Film.Name.json
│   └── tv_Serie.Name.json
├── cache_itunes/
│   └── Artist_Album.Name.json
└── trackers.fingerprint.sha256
```

---

## Key Constants

Located in `scene-maker.js`:

| Constant | Value | Purpose |
|----------|-------|---------|
| DEST_DIR | `/data/torrent` | Base output directory for all generated artifacts |
| CACHE_DIR | `/data/cache_tmdb` | TMDb API response cache directory |
| CACHE_DIR_ITUNES | `/data/cache_itunes` | iTunes API response cache directory |
| FINGERPRINT_FILE | `/data/trackers.fingerprint.sha256` | Tracker URL fingerprint storage |
| VIDEO_EXT | `['mkv','mp4','avi','mov','flv','wmv','m4v']` | Recognized video file extensions |
| AUDIO_EXT | `['mp3','flac','aac','wav']` | Recognized audio file extensions |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| TRACKERS | Yes | — | Comma-separated announce URLs for torrent creation |
| TMDB_API_KEY | If ENABLE_FILMS or ENABLE_SERIES | — | TMDb API key for metadata lookup |
| ENABLE_FILMS | Yes (min 1 type) | — | Enable film processing (`true`/`false`) |
| ENABLE_SERIES | Yes (min 1 type) | — | Enable series processing (`true`/`false`) |
| ENABLE_MUSIQUES | Yes (min 1 type) | — | Enable music processing (`true`/`false`) |
| FILMS_DIRS | No | `/films` | Comma-separated source directories for films |
| SERIES_DIRS | No | `/series` | Comma-separated source directories for series |
| MUSIQUES_DIRS | No | `/musiques` | Comma-separated source directories for music |
| PARALLEL_JOBS | No | `1` | Concurrent processing jobs (concurrency limit) |
| SCAN_COOLDOWN | No | `5` | Seconds between inotify-triggered scans |
| PUID | No | — | Docker user ID for su-exec mapping |
| PGID | No | — | Docker group ID for su-exec mapping |

**Deployment notes**:
- At least one of ENABLE_FILMS, ENABLE_SERIES, or ENABLE_MUSIQUES must be true
- TRACKERS and media type toggles are mandatory for basic operation
- TMDB_API_KEY required only if films or series are enabled
- Directories in CSV format accept multiple paths for media organization

---

## Docker Build & Deployment

### Multi-stage Dockerfile

The Dockerfile uses a multi-stage build process:

1. **Stage 1**: Go builder
   - Compiles mkbrr from source
   - Produces statically-linked binary

2. **Stage 2**: Node.js 20 Alpine runtime
   - Imports mkbrr binary from stage 1
   - Installs Python 3, GuessIt, mediainfo, inotify-tools
   - Creates Python virtualenv for GuessIt isolation
   - Sets up Node.js application files
   - Configures USER node (non-root)

### Docker Compose Example

`docker-compose.yml` provides reference deployment configuration:

```yaml
services:
  mediatorr:
    build: .
    image: mediatorr:latest
    environment:
      TRACKERS: "http://tracker.example.com:6969/announce"
      TMDB_API_KEY: "your_key_here"
      ENABLE_FILMS: "true"
      ENABLE_SERIES: "true"
      ENABLE_MUSIQUES: "true"
    volumes:
      - ./films:/films:ro
      - ./series:/series:ro
      - ./musiques:/musiques:ro
      - ./torrent:/data/torrent
```

---

## CI/CD Pipeline

### Docker Build & Push (`.github/workflows/docker-publish.yml`)

Automated image building and registry publishing.

**Triggers**:
- Push to `main` or `develop` branch (filtered by code-related paths)
- Manual workflow dispatch (`workflow_dispatch`)

**Build strategy**:
- Matrix build per architecture (amd64 enabled, arm64 commented out)
- Native GitHub Actions runners for each architecture
- Docker buildx for multi-platform image creation

**Registry targets**:
- **GHCR**: `ghcr.io/{user}/mediatorr`
- **Docker Hub**: `johandevl/mediatorr`

**Image tagging**:
- `latest` (main branch only)
- Semantic version from VERSION file (e.g., `1.1.2`)
- Branch name (e.g., `develop`)
- Short commit SHA (e.g., `a1b2c3d`)

**Caching**:
- GitHub Actions cache per architecture scope
- Reduces build time on subsequent runs

**Build flow**:
1. Build per-platform images
2. Push digest references to GHCR
3. Merge manifests into final multi-platform image
4. Copy manifest to Docker Hub (same tag set)

### Auto Tag (`.github/workflows/auto-tag.yml`)

Automatic git tag creation on version changes.

**Trigger**: Push to `main` that modifies `VERSION` file

**Process**:
1. Compares current VERSION against previous commit
2. If changed and git tag doesn't exist:
   - Creates annotated tag: `v{version}`
   - Pushes to repository
3. If tag already exists, skips creation

**Purpose**: Enables automatic GitHub release creation and semantic versioning

---

## Error Handling & Resilience

### Graceful Degradation

- **Tracker fingerprinting**: Continues even if fingerprint update fails
- **inotifywait errors**: watch.sh continues on monitoring errors
- **API failures**: Falls back to cached data if available
- **Corrupt cache**: Automatically purged and re-fetched
- **Disk full**: saveSourceInfo() includes try-catch around file writes

### Logging & Monitoring

- Console logging of processing status
- File write failures logged per item
- API timeouts and retries managed by axios
- Cache corruption events recorded for debugging

---

## Performance Considerations

### Single-Threaded with Concurrency Control

- Default: Serial processing (PARALLEL_JOBS=1) for deterministic behavior
- Optional: Increase PARALLEL_JOBS to utilize multi-core systems
- Limit: Tracker fingerprinting serialized before parallel processing begins

### Directory Monitoring

- inotifywait cooldown prevents scan storms during rapid file changes
- Configurable via SCAN_COOLDOWN (default 5 seconds)
- Aggregates multiple file events into single scan

### Cache Efficiency

- Local API response caching eliminates redundant API calls
- Corrupt cache auto-recovery prevents cascading failures
- Cache lookup key includes parsed filename (GuessIt output)

---

## Security Considerations

### Non-Root Execution

- Docker image runs as unprivileged `node` user
- PUID/PGID mapping (via docker-entrypoint.sh) aligns container user with host
- Read-only source directories recommended (`/films:ro`, etc.)

### API Keys

- TMDB_API_KEY passed via environment variables
- Keys not logged or stored in generated artifacts
- Consider using Docker secrets for production deployments

### File Permissions

- Generated torrents inherit ownership from /data directory
- PUID/PGID ensures cross-host permission compatibility
- su-exec used for credential switching (docker-entrypoint.sh)

---

## Extensibility

### Adding New Media Types

1. Extend media type constants in scene-maker.js
2. Add environment variable for type toggle and directories
3. Create type-specific parsing and metadata lookup logic
4. Define output directory structure
5. Implement skip check for new artifact types

### Custom Metadata Sources

1. Implement API client (axios recommended)
2. Add cache management parallel to TMDb/iTunes
3. Define cache file naming convention
4. Integrate into metadata lookup pipeline

### Tracker Configuration

- TRACKERS environment variable accepts comma-separated URLs
- Fingerprinting detects changes automatically
- mkbrr modify updates all existing torrents on change
- No manual torrent re-creation needed for tracker changes
