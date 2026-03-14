#!/bin/bash
# Build OpenWork SolidJS chat app and copy to Docker volume
set -e

cd "$(dirname "$0")/../packages/app"
echo "Building OpenWork app..."
VITE_OPENWORK_URL="" pnpm build
echo "Build complete: $(ls -la dist/index.html)"
echo ""
echo "To deploy: copy dist/ contents to the openwork_dist Docker volume"
echo "  docker cp dist/. \$(docker compose ps -q pantheon):/app/openwork-dist/"
