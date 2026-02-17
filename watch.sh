#!/bin/sh
set -e

ENABLE_FILMS="${ENABLE_FILMS:-false}"
ENABLE_SERIES="${ENABLE_SERIES:-false}"
ENABLE_MUSIQUES="${ENABLE_MUSIQUES:-false}"

has_partial_files() {
  DIR="$1"
  find "$DIR" -maxdepth 1 -type f \( \
    -name "*.part" \
    -o -name "*.tmp" \
    -o -name "*.crdownload" \
  \) | grep -q .
}

watch_dir() {
  DIR="$1"
  LABEL="$2"
  LAST_SCAN=0
  COOLDOWN=${SCAN_COOLDOWN:-5}

  echo "👀 Surveillance activée pour $LABEL : $DIR"

  inotifywait -m -r \
    -e create -e moved_to -e close_write \
    --format '%w%f' \
    "$DIR" 2>/dev/null | while read path
  do
    # on ignore les fichiers temporaires eux-mêmes
    case "$path" in
      *.part|*.tmp|*.crdownload)
        continue
        ;;
    esac

    PARENT="$(dirname "$path")"

    # ⛔ tant qu'il reste un .part dans le dossier → on attend
    if has_partial_files "$PARENT"; then
      echo "⏳ Téléchargement en cours ($LABEL) : $PARENT"
      continue
    fi

    case "$path" in
      *.mkv|*.mp4|*.avi|*.mov|*.flv|*.wmv|*.m4v|*.mp3|*.flac|*.aac|*.wav)
        # cooldown pour éviter les scans redondants (create + close_write)
        NOW=$(date +%s)
        if [ $((NOW - LAST_SCAN)) -lt "$COOLDOWN" ]; then
          continue
        fi
        echo "✅ Téléchargement terminé ($LABEL) : $(basename "$path")"
        LAST_SCAN=$(date +%s)
        node /app/scene-maker.js || echo "⚠️ Erreur scene-maker ($LABEL), reprise au prochain événement"
        ;;
      *)
        if [ -d "$path" ]; then
          echo "📁 Nouveau dossier détecté ($LABEL) : $(basename "$path")"
          LAST_SCAN=$(date +%s)
          node /app/scene-maker.js || echo "⚠️ Erreur scene-maker ($LABEL), reprise au prochain événement"
        fi
        ;;
    esac
  done
}

# -------- WEB SERVER --------
ENABLE_WEB="${ENABLE_WEB:-true}"
WEB_PORT="${WEB_PORT:-5765}"
if [ "$ENABLE_WEB" = "true" ]; then
  echo "🌐 Starting web interface on port $WEB_PORT"
  WEB_PORT="$WEB_PORT" node /app/web/server.js &
fi
# -----------------------------

FILMS_DIRS="${FILMS_DIRS:-/films}"
SERIES_DIRS="${SERIES_DIRS:-/series}"
MUSIQUES_DIRS="${MUSIQUES_DIRS:-/musiques}"

start_watchers() {
  ENABLED="$1"
  DIRS_RAW="$2"
  LABEL="$3"
  [ "$ENABLED" != "true" ] && return
  OLD_IFS="$IFS"
  IFS=','
  for DIR in $DIRS_RAW; do
    DIR=$(echo "$DIR" | xargs)
    if [ -d "$DIR" ]; then
      watch_dir "$DIR" "$LABEL" &
    else
      echo "⚠️ Répertoire introuvable ($LABEL) : $DIR"
    fi
  done
  IFS="$OLD_IFS"
}

start_watchers "$ENABLE_FILMS" "$FILMS_DIRS" "films"
start_watchers "$ENABLE_SERIES" "$SERIES_DIRS" "series"
start_watchers "$ENABLE_MUSIQUES" "$MUSIQUES_DIRS" "musiques"

if [ "$ENABLE_FILMS" != "true" ] && \
   [ "$ENABLE_SERIES" != "true" ] && \
   [ "$ENABLE_MUSIQUES" != "true" ]; then
  echo "❌ Aucun dossier surveillé"
  exit 1
fi

wait