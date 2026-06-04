#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Build & push to GitHub Container Registry (ghcr.io)
#
#  FIRST-TIME SETUP (once per machine):
#    1. Create a GitHub Personal Access Token at:
#       https://github.com/settings/tokens  -> "Generate new token (classic)"
#       Required scope: write:packages  (includes read:packages + delete:packages)
#    2. Log in (paste your token when prompted):
#       echo "ghp_xxxxxxxxxxxxxxxxxxxx" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
#       Docker stores the credentials; you never need to log in again.
#
#  USAGE:
#    ./docker-push.sh                   # patch bump:  1.0.0 -> 1.0.1
#    ./docker-push.sh minor             # minor bump:  1.0.0 -> 1.1.0
#    ./docker-push.sh major             # major bump:  1.0.0 -> 2.0.0
#    ./docker-push.sh 2.3.0             # exact version
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config — edit these two lines ────────────────────────────────────────────
GITHUB_USER="ilic5000"
IMAGE_NAME="it-cup-obs-extension"
# ─────────────────────────────────────────────────────────────────────────────

REGISTRY="ghcr.io"
FULL_IMAGE="$REGISTRY/$GITHUB_USER/$IMAGE_NAME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_JSON="$SCRIPT_DIR/package.json"

# ── Read current version from package.json ───────────────────────────────────
CURRENT_VERSION=$(grep -m1 '"version"' "$PKG_JSON" | sed 's/.*"version": *"\([^"]*\)".*/\1/')

ARG="${1:-patch}"

# If the arg looks like a version number (x.y.z), use it directly
if [[ "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NEW_VERSION="$ARG"
else
    BUMP="$ARG"
    MAJ=$(echo "$CURRENT_VERSION" | cut -d. -f1)
    MIN=$(echo "$CURRENT_VERSION" | cut -d. -f2)
    PAT=$(echo "$CURRENT_VERSION" | cut -d. -f3)

    case "$BUMP" in
        major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
        minor) MIN=$((MIN + 1)); PAT=0 ;;
        patch) PAT=$((PAT + 1)) ;;
        *)
            echo "  Unknown bump type: $BUMP  (use patch, minor, major, or x.y.z)"
            exit 1
            ;;
    esac
    NEW_VERSION="$MAJ.$MIN.$PAT"
fi

echo ""
echo "  Current version : $CURRENT_VERSION"
echo "  New version     : $NEW_VERSION"
echo "  Image           : $FULL_IMAGE:$NEW_VERSION"
echo ""

read -rp "  Proceed? [Y/n] " CONFIRM
if [[ "$CONFIRM" =~ ^[nN] ]]; then
    echo "  Aborted."
    exit 0
fi

# ── Bump version in package.json ─────────────────────────────────────────────
sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PKG_JSON"
echo "  [OK] package.json updated -> $NEW_VERSION"

# ── Build ─────────────────────────────────────────────────────────────────────
echo ""
echo "  Building $FULL_IMAGE ..."
docker build \
    --label "org.opencontainers.image.version=$NEW_VERSION" \
    --label "org.opencontainers.image.source=https://github.com/$GITHUB_USER/$IMAGE_NAME" \
    -t "$FULL_IMAGE:$NEW_VERSION" \
    -t "$FULL_IMAGE:latest" \
    "$SCRIPT_DIR"
echo "  [OK] Build done."

# ── Push ─────────────────────────────────────────────────────────────────────
echo ""
echo "  Pushing $FULL_IMAGE:$NEW_VERSION ..."
docker push "$FULL_IMAGE:$NEW_VERSION"

echo "  Pushing $FULL_IMAGE:latest ..."
docker push "$FULL_IMAGE:latest"

echo ""
echo "  [OK] Published successfully!"
echo ""
echo "  ghcr.io image  : $FULL_IMAGE:$NEW_VERSION"
echo "  Pull command   : docker pull $FULL_IMAGE:$NEW_VERSION"
echo ""
