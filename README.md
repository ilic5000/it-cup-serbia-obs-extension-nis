# IT Cup Serbia - OBS Extension

OBS browser-source overlay for IT Cup Serbia futsal league. Auto-fetches live match data from [itkupsrbije.com](https://itkupsrbije.com), provides a scoreboard, goal/card announcements, match timer, and a statistics panel.

> For a demo walktrough video, open [`resources/it-cup-demo-walktrough.mp4`](resources/it-cup-demo-walktrough.mp4) directly.

---

## Overlays

| Source | Size | Purpose |
|---|---|---|
| `/overlay.html` | 1920×150 or 1920×1080 | Live scoreboard (bar or corner widget) |
| `/goal-overlay.html` | 1920×1080 | Goal / yellow card / red card announcement |
| `/stats-overlay.html` | 1920×1080 | Player or team statistics panel |

Configure and control everything from **`/settings.html`**.

---

## Run

### Option A: `start.bat` (Windows, no Docker)

Requires [Node.js 18+](https://nodejs.org).

```bat
npm install
start.bat
```

Open `http://localhost:3042/settings.html`.  
Edit `SET PORT=3042` inside `start.bat` to change the port.

---

### Option B: Docker Compose

```bash
docker compose up -d
```

`settings.json` is volume-mounted so settings survive container restarts.  
Change the port in `docker-compose.yml` if needed (`"3042:3042"`).

```bash
docker compose down        # stop
docker compose logs -f     # logs
```

---

### Option C: Pull from GitHub Container Registry

A pre-built image is published to `ghcr.io/ilic5000/it-cup-obs-extension`.

```bash
docker pull ghcr.io/ilic5000/it-cup-obs-extension:latest

docker run -d \
  -p 3042:3042 \
  -v $(pwd)/settings.json:/app/settings.json \
  --restart unless-stopped \
  ghcr.io/ilic5000/it-cup-obs-extension:latest
```

On Windows PowerShell replace `$(pwd)` with `${PWD}`.

---

## Build & publish your own image

```powershell
# Windows
.\docker-push.ps1              # patch bump (1.0.0 -> 1.0.1)
.\docker-push.ps1 -Bump minor
.\docker-push.ps1 -Version 2.0.0

# Linux / macOS
./docker-push.sh               # patch bump
./docker-push.sh minor
./docker-push.sh 2.0.0
```

First-time setup: create a GitHub PAT with `write:packages` scope and run:

```bash
echo "ghp_YOUR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Then edit `$GITHUB_USER` at the top of `docker-push.ps1` / `docker-push.sh`.

---

## OBS Setup

1. **Settings** → paste the game URL from itkupsrbije.com → **Fetch** → **Save & Activate**
2. In OBS add three **Browser Sources** using the URLs shown on the settings page
3. Use **Live Focus Mode** (toggle at the top of settings) during matches to hide config cards

