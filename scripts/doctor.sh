#!/usr/bin/env bash
# OmniAction OS environment doctor (shell wrapper).
# The Python script is the single source of truth; this exists so the
# documented `./scripts/doctor.sh` works without remembering to type python3.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL  python3 not found — the doctor needs Python 3.10+." >&2
  exit 1
fi

exec python3 "$DIR/doctor.py" "$@"