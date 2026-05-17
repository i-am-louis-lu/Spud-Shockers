#!/bin/bash
# Spud Shockers — macOS / Linux launcher.
# Double-click this file in Finder to start the local server on port 8000.
# Open http://localhost:8000/ in any browser. Press Ctrl+C in this window to stop.
#
# First-time setup on macOS: you may need to make this file executable. Open
# Terminal in this folder and run:   chmod +x serve.command

cd "$(dirname "$0")" || exit 1
PORT=8000

echo ""
echo "  =============================="
echo "  SPUD SHOCKERS - Local Server"
echo "  =============================="
echo ""
echo "  Open this in your browser:"
echo "    http://localhost:$PORT/"
echo ""
echo "  Press Ctrl+C in this window to stop the server."
echo ""

if command -v python3 >/dev/null 2>&1; then
  echo "  (using python3 http.server)"
  python3 -m http.server $PORT
elif command -v ruby >/dev/null 2>&1; then
  echo "  (using ruby httpd)"
  ruby -run -e httpd . -p $PORT
elif command -v php >/dev/null 2>&1; then
  echo "  (using php built-in server)"
  php -S "localhost:$PORT"
elif command -v python >/dev/null 2>&1; then
  echo "  (using python SimpleHTTPServer)"
  python -m SimpleHTTPServer $PORT
else
  echo ""
  echo "  Could not find python3, ruby, php, or python on this system."
  echo "  Easiest fix on macOS: open Terminal and run"
  echo "      xcode-select --install"
  echo "  That installs python3, then double-click this file again."
  echo ""
  read -rp "  Press Enter to close..."
fi
