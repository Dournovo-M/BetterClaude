#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# claude-taskboard :: lanceur de la TUI (100 % clavier, vert/noir)
# TUI Node + neo-blessed pilotée uniquement au clavier :
# Tab/1/2/3 pour naviguer, Entrée pour ouvrir les fiches, Ctrl+S pour envoyer,
# m = modèle (Claude uniquement), w = dossier de travail.
# Nécessite un vrai terminal interactif — pas de pipe/script non-interactif.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# Résout le vrai dossier du script même invoqué via un symlink (ex: ~/cli.sh)
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
    DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")" && pwd)"
cd "$ROOT"

if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:8010/api/state; then
    echo "❌ Le serveur ne répond pas sur http://127.0.0.1:8010"
    echo "   Lance-le d'abord : node ${ROOT}/server.js"
    exit 1
fi

if [ ! -d "$ROOT/node_modules/neo-blessed" ]; then
    echo "📦 Dépendance manquante (neo-blessed) — installation..."
    npm install || { echo "❌ npm install a échoué."; exit 1; }
fi

exec node "$ROOT/tui.js"
