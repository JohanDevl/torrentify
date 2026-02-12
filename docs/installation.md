# Mediatorr Installation and Usage Guide

Mediatorr is a Docker-based automation tool that monitors media directories and generates `.torrent`, `.nfo`, and metadata `.txt` files for films, series, and music. This guide covers installation, configuration, and troubleshooting.

## Prerequisites

Before installing Mediatorr, ensure you have:

- **Docker** and **Docker Compose** installed on your system
- A **TMDb API key** (required if processing films or series)
  - Register at https://www.themoviedb.org/settings/api
  - Choose "Developer" when requesting an API key
  - Copy the "API Key (v3 auth)" value
- **Private tracker announce URLs** (at least one)
- Media files organized in directories by type (films, series, music)

## Quick Start

For a minimal setup with just films:

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
      - /path/to/your/films:/films
      - /path/to/output:/data
```

Save this as `docker-compose.yml` and run:

```bash
docker compose up -d
```

Monitor progress with:

```bash
docker logs -f mediatorr
```

## Full Configuration Example

For a complete setup with films, series, and music across multiple directories:

```yaml
services:
  mediatorr:
    image: johandevl/mediatorr:latest
    container_name: mediatorr
    restart: unless-stopped
    user: "1000:1000"
    environment:
      - ENABLE_FILMS=true
      - ENABLE_SERIES=true
      - ENABLE_MUSIQUES=true
      - TMDB_API_KEY=your_tmdb_api_key
      - TRACKERS=https://tracker1.com/announce,https://tracker2.com/announce
      - FILMS_DIRS=/films,/films-4k
      - SERIES_DIRS=/series,/series-4k
      - MUSIQUES_DIRS=/musiques
      - PARALLEL_JOBS=2
      - SCAN_COOLDOWN=5
    volumes:
      - /mnt/user/data/films:/films
      - /mnt/user/data/films-4k:/films-4k
      - /mnt/user/data/series:/series
      - /mnt/user/data/series-4k:/series-4k
      - /mnt/user/data/musiques:/musiques
      - /mnt/user/data/torrent:/data
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TRACKERS` | Yes | — | Comma-separated tracker announce URLs |
| `TMDB_API_KEY` | If films/series enabled | — | TMDb API key for metadata lookup |
| `ENABLE_FILMS` | Yes (at least 1) | — | Enable film processing (`true` or `false`) |
| `ENABLE_SERIES` | Yes (at least 1) | — | Enable series processing (`true` or `false`) |
| `ENABLE_MUSIQUES` | Yes (at least 1) | — | Enable music processing (`true` or `false`) |
| `FILMS_DIRS` | No | `/films` | Comma-separated film source directories |
| `SERIES_DIRS` | No | `/series` | Comma-separated series source directories |
| `MUSIQUES_DIRS` | No | `/musiques` | Comma-separated music source directories |
| `PARALLEL_JOBS` | No | `1` | Number of concurrent processing jobs |
| `SCAN_COOLDOWN` | No | `5` | Seconds between inotify-triggered scans |
| `PUID` | No | — | User ID for container process (Unraid/NAS) |
| `PGID` | No | — | Group ID for container process (Unraid/NAS) |

## Volume Mapping

### Input Volumes

Map your media directories to the container paths. Default paths are `/films`, `/series`, and `/musiques`. You can customize these:

```yaml
volumes:
  # Single directory (uses default /films path)
  - /mnt/films:/films

  # Multiple directories (set FILMS_DIRS=/films,/films-4k)
  - /mnt/films:/films
  - /mnt/films-4k:/films-4k

  # Output directory (required)
  - /mnt/torrent:/data
```

### Output Volume

The `/data` volume is mandatory and stores:

- Generated `.torrent`, `.nfo`, and `.txt` files organized by type
- API response caches for TMDb and iTunes
- Tracker fingerprint for announce URL updates
- Source file metadata for change detection

Ensure the mounted directory is writable by the container user.

## User Permissions and PUID/PGID

### Docker User Mode (Recommended)

The simplest approach is to specify the user directly:

```yaml
user: "1000:1000"
```

Replace `1000:1000` with your UID:GID. To find your user ID:

```bash
id
```

### PUID/PGID Environment Variables

For NAS systems requiring user/group mapping, use `PUID` and `PGID`:

```yaml
environment:
  - PUID=1000
  - PGID=1000
```

The container's entrypoint creates the user/group with these IDs.

### Unraid-specific

On Unraid, use:

```yaml
user: "99:100"  # nobody:users
```

Or set:

```yaml
environment:
  - PUID=99
  - PGID=100
```

## Getting a TMDb API Key

1. Visit https://www.themoviedb.org/ and create a free account
2. Go to **Settings** → **API** → **Request an API Key**
3. Choose **Developer** and complete the registration form
4. You will receive your **API Key (v3 auth)**
5. Add to your docker-compose.yml:

```yaml
environment:
  - TMDB_API_KEY=your_api_key_here
```

## Supported File Formats

### Video Files (Films and Series)

- `.mkv`
- `.mp4`
- `.avi`
- `.mov`
- `.flv`
- `.wmv`
- `.m4v`

### Audio Files (Music)

- `.mp3`
- `.flac`
- `.aac`
- `.wav`

## Output Structure

Mediatorr generates the following directory structure in your `/data` volume:

```
/data/
├── torrent/
│   ├── films/
│   │   └── Film.Name/
│   │       ├── Film.Name.torrent
│   │       ├── Film.Name.nfo
│   │       ├── Film.Name.source.nfo     (if source NFO exists)
│   │       ├── Film.Name.txt
│   │       └── Film.Name.srcinfo        (source change tracking)
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
├── cache_tmdb/                         (TMDb API response cache)
├── cache_itunes/                       (iTunes API response cache)
└── trackers.fingerprint.sha256         (Tracker URL fingerprint)
```

## Verifying Installation

After starting the container, verify everything is working:

1. **Check container logs:**

```bash
docker logs mediatorr
```

You should see messages about scanning directories and processing media files.

2. **Verify output directory:**

Check that files appear in your `/data` mount:

```bash
ls -la /path/to/output/torrent/films/
```

3. **Watch real-time processing:**

```bash
docker logs -f mediatorr
```

## Troubleshooting

### "No directory monitored" Error

This occurs when all `ENABLE_*` variables are `false`. Ensure at least one of the following is `true`:

```yaml
environment:
  - ENABLE_FILMS=true
  - ENABLE_SERIES=true
  - ENABLE_MUSIQUES=true
```

### No Output Generated

Check the logs for specific errors:

```bash
docker logs mediatorr
```

Common causes:

- Media files don't have supported extensions
- Filenames don't follow standard naming conventions
- Volume mappings are incorrect
- The container lacks read access to source directories

### TMDb API Errors ("Not found" or blank metadata)

Verify your API key:

- Ensure `TMDB_API_KEY` is set correctly
- Test the key at https://www.themoviedb.org/settings/api
- Ensure film/series filenames follow standard conventions (e.g., "Film Name (2020)" or "Series.Name.S01E01")

Check the container logs:

```bash
docker logs mediatorr | grep -i tmdb
```

### Permission Denied Errors

Ensure proper access:

- Source directories: container user must have **read** access
- Output directory (`/data`): container user must have **write** access

Verify with:

```bash
ls -la /path/to/films
ls -la /path/to/output
```

### Torrent Not Regenerated After File Change

Mediatorr detects file changes but waits for the scan cooldown period. Default is 5 seconds:

```yaml
environment:
  - SCAN_COOLDOWN=5
```

To force a rescan, restart the container:

```bash
docker restart mediatorr
```

### API Cache Corruption

If API caches become corrupted, the application automatically repairs them. If issues persist, delete the cache directories and restart:

```bash
rm -rf /path/to/output/cache_tmdb/
rm -rf /path/to/output/cache_itunes/
docker restart mediatorr
```

## Unraid-specific Setup

1. **Install from Community Applications:**
   - Search for "Mediatorr"
   - Add as a custom Docker container

2. **Configure volumes:**
   - Map your media shares to container paths
   - Map output share to `/data`

3. **Set environment variables:**

```
ENABLE_FILMS=true
ENABLE_SERIES=false
ENABLE_MUSIQUES=false
TMDB_API_KEY=your_key
TRACKERS=https://your-tracker.com/announce
```

4. **Set user:**

```
User: 99:100  (nobody:users)
```

5. **Save and apply**

6. **Monitor logs:**
   - Docker tab → Mediatorr → Logs

## Docker Registry

Mediatorr is available on two registries:

- **Docker Hub:** `johandevl/mediatorr:latest`
- **GitHub Container Registry:** `ghcr.io/johandevl/mediatorr:latest`

Use either in your docker-compose.yml.

## Media Type Processing Details

### Films

- Each video file in the films directory is processed individually
- Supports recursive directory scanning
- Metadata is fetched from TMDb using the film title and year from the filename

### Series

- Entire folders are processed as a single torrent
- Auto-detects season-based naming (e.g., "Series.Name.S01E01")
- Renames season folders to season-only notation when applicable
- Metadata is fetched from TMDb TV series database

### Music

- Albums or individual audio files in music directories
- Waits for file download completion before processing
- Metadata is fetched from iTunes API
- Supports nested audio file structures

## Updating Trackers

If you need to update tracker announce URLs after deployment:

1. Update the `TRACKERS` environment variable in docker-compose.yml
2. Restart the container

```bash
docker compose up -d
```

Mediatorr automatically detects the change and updates all existing `.torrent` files using `mkbrr modify`.

## Performance Tuning

Adjust `PARALLEL_JOBS` to control concurrent processing:

```yaml
environment:
  - PARALLEL_JOBS=1     # Default: process one item at a time
  - PARALLEL_JOBS=4     # Process up to 4 items concurrently
```

Higher values process faster but consume more resources. Adjust based on your system's CPU and I/O capacity.

## Getting Help

If you encounter issues not covered in this guide:

1. Check the container logs: `docker logs mediatorr`
2. Review the Troubleshooting section above
3. Verify all prerequisites are met
4. Ensure media filenames follow standard naming conventions
5. Confirm API keys and tracker URLs are correct
