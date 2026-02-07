# 🧲 Torrentify

**Torrentify** est un conteneur Docker qui génère automatiquement des fichiers
**.torrent**, **.nfo** et des métadonnées **TMDb / iTunes** à partir de **films, séries et musiques**.

Il surveille un ou plusieurs dossiers, analyse les noms de fichiers,
récupère les informations depuis **TMDb** (films & séries) et **iTunes** (musiques),
et prépare des fichiers propres et prêts à l'usage pour les **trackers privés** depuis une machine **Unraid**, **NAS** et **seedbox**.

---

## ✨ Fonctionnalités

- 🎬 Génération automatique de fichiers `.torrent` via `mkbrr`
- 🧲 Trackers configurables avec mise à jour automatique des `.torrent` existants si les URLs changent
- 📝 Création de fichiers `.nfo` (mediainfo, sans chemins absolus)
- 📋 Copie automatique des `.nfo` source dans le dossier de sortie
- 📄 Fichier `.txt` avec ID TMDb ou message explicite si non trouvé
- 👀 Surveillance en temps réel via `inotifywait` (création, déplacement, écriture)
- 📂 Support de **répertoires sources multiples** par type de média (ex: `/films` + `/films-4k`)
- 🔄 Scan initial automatique au démarrage du conteneur
- 🔍 Scan récursif des sous-dossiers
- 🧠 Analyse intelligente des noms de fichiers (GuessIt)
- 🎞️ Recherche **TMDb** (FR puis EN) et **iTunes** avec cache local persistant
- 📦 Cache auto-recréé si supprimé ou corrompu
- ⚙️ Activation indépendante des **films**, **séries** et des **musiques**
- 🎯 Détection automatique saison vs série complète avec nombre de fichiers et taille totale dans le NFO
- ⏳ Détection des téléchargements en cours (`.part`, `.tmp`, `.crdownload`)
- 🔄 Détection des modifications de fichiers source (taille/mtime) avec retraitement automatique
- ⚡ Traitement parallèle configurable
- 📁 Sortie structurée par type (films / séries / musiques)
- 🐳 Image Docker légère basée sur Alpine
- 🧱 Compatible multi-architecture (`amd64` / `arm64`)

---

## ⚙️ Variables d'environnement

### Requises

| Variable | Description |
|--------|------------|
| `TRACKERS` | URLs des trackers (séparées par des virgules) |
| `TMDB_API_KEY` | Clé API TMDb (requis si films ou séries activés) |

### Activation des médias

| Variable | Description |
|--------|------------|
| `ENABLE_FILMS` | Active le traitement et la surveillance des films (`true` / `false`) |
| `ENABLE_SERIES` | Active le traitement et la surveillance des séries (`true` / `false`) |
| `ENABLE_MUSIQUES` | Active le traitement et la surveillance des musiques (`true` / `false`) |

> ⚠️ **Au moins un des trois** doit être activé.

### Répertoires sources (optionnel)

| Variable | Description |
|--------|------------|
| `FILMS_DIRS` | Répertoires source des films, séparés par virgules (défaut : `/films`) |
| `SERIES_DIRS` | Répertoires source des séries, séparés par virgules (défaut : `/series`) |
| `MUSIQUES_DIRS` | Répertoires source des musiques, séparés par virgules (défaut : `/musiques`) |

> Permet de surveiller plusieurs dossiers par type, ex: `FILMS_DIRS=/films,/films-4k`

### Optionnelles

| Variable | Description |
|--------|------------|
| `PARALLEL_JOBS` | Nombre de fichiers traités en parallèle (défaut : `1`) |
| `SCAN_COOLDOWN` | Délai en secondes entre deux scans consécutifs (défaut : `5`) |
| `PUID` | User ID du processus dans le conteneur (défaut : `99`) |
| `PGID` | Group ID du processus dans le conteneur (défaut : `100`) |

---

## 📁 Volumes

### 📥 Entrée (médias)

| Chemin conteneur | Description |
|-----------------|------------|
| `/films` | Dossier des films par défaut (configurable via `FILMS_DIRS`) |
| `/series` | Dossier des séries par défaut (configurable via `SERIES_DIRS`) |
| `/musiques` | Dossier des musiques par défaut (configurable via `MUSIQUES_DIRS`) |

### 📤 Sortie

| Chemin conteneur | Description |
|-----------------|------------|
| `/data` | Torrents, NFO, fichiers TXT générés et caches API |

---

## 📂 Structure générée

```text
data/
├── films/
│   └── Nom.Film/
│       ├── Nom.Film.torrent
│       ├── Nom.Film.nfo
│       ├── Nom.Film.source.nfo    ← copie du NFO source (si présent)
│       └── Nom.Film.txt
├── series/
│   └── Nom.Serie.S01/
│       ├── Nom.Serie.S01.torrent
│       ├── Nom.Serie.S01.nfo
│       ├── Nom.Serie.S01.source.nfo
│       └── Nom.Serie.S01.txt
├── musiques/
│   └── Nom.Album/
│       ├── Nom.Album.torrent
│       ├── Nom.Album.nfo
│       └── Nom.Album.txt
├── cache_tmdb/
│   └── *.json
├── cache_itunes/
│   └── *.json
└── trackers.fingerprint.sha256
```

---

## 🚀 Exemple docker-compose

```yaml
services:
  torrentify:
    image: johandevl/torrentify:latest
    container_name: torrentify
    restart: unless-stopped

    user: "1000:1000"

    environment:
      # Activation des médias
      - ENABLE_FILMS=true
      - ENABLE_SERIES=false
      - ENABLE_MUSIQUES=true
      # TMDb
      - TMDB_API_KEY=votre_cle_tmdb
      # Trackers (séparés par virgules)
      - TRACKERS=https://tracker1/announce,https://tracker2/announce
      # Répertoires sources multiples (optionnel, séparés par virgules)
      # - FILMS_DIRS=/films,/films-4k
      # - SERIES_DIRS=/series,/series-4k
      # Optionnel
      - PARALLEL_JOBS=1

    volumes:
      # Entrées
      - /source/films:/films
      - /source/series:/series
      - /source/musiques:/musiques
      # Entrées supplémentaires (décommenter si multi-répertoire)
      # - /source/films-4k:/films-4k
      # - /source/series-4k:/series-4k

      # Sorties
      - /destination/torrent:/data
```

---

## 🔧 Gestion des trackers

Au démarrage, Torrentify calcule un fingerprint SHA256 des URLs de trackers configurées. Si les trackers ont changé depuis le dernier lancement, tous les fichiers `.torrent` existants sont automatiquement mis à jour avec les nouvelles URLs via `mkbrr modify`.

---

## 📝 Notes

- **Films** : un fichier = un torrent, recherche TMDb
- **Séries** : un dossier = un torrent, détection automatique saison/série, recherche TMDb
- **Musiques** : un album (dossier ou fichier) = un torrent, recherche iTunes, attente fin des `.part`
- Les fichiers déjà traités ne sont jamais régénérés
- Les caches API sont persistants et auto-réparés
