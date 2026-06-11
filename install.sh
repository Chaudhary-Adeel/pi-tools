#!/usr/bin/env bash
# install.sh — symlink pi-coding-toolkit into pi's extension directory.
# Run this once to install, or again to "reinstall" (it replaces the link).
#
# After source changes, just restart pi or run /reload inside pi.
# No reinstall needed since we use a symlink to the source files.

set -euo pipefail

EXT_DIR="${HOME}/.pi/agent/extensions/pi-coding-toolkit"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== pi-coding-toolkit installer ==="

# Remove old link/dir if present
if [ -L "${EXT_DIR}" ] || [ -d "${EXT_DIR}" ]; then
  echo "Removing previous installation at ${EXT_DIR}"
  rm -rf "${EXT_DIR}"
fi

# Create parent dir
mkdir -p "$(dirname "${EXT_DIR}")"

# Symlink the project into pi's extensions as a subdirectory extension
ln -sf "${SRC_DIR}" "${EXT_DIR}"

echo "✓ Symlinked ${EXT_DIR} -> ${SRC_DIR}"
echo ""
echo "The following files are now registered with pi:"
echo "  ${EXT_DIR}/src/index.ts  (main extension entry)"
echo "  ${EXT_DIR}/package.json   (pi package manifest)"
echo ""
echo "Restart pi or run /reload inside pi to pick up changes."
echo "To uninstall: rm -rf ${EXT_DIR}"
