#!/bin/bash
set -euo pipefail

# Build workspace Docker image (PxyCrab is compiled in a multi-stage Dockerfile)
cd "$(dirname "$0")"
docker build -t openwork/workspace:latest .
echo "✓ openwork/workspace:latest built"
