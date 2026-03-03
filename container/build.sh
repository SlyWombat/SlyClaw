#!/bin/bash
#
#   ____  _            ____ _
#  / ___|| |_   _     / ___| | __ ___      __
#  \___ \| | | | |   | |   | |/ _` \ \ /\ / /
#   ___) | | |_| |   | |___| | (_| |\ V  V /
#  |____/|_|\__, |    \____|_|\__,_| \_/\_/
#           |___/
#  Cunning. Sturdy. Open.
#
#  Based on the NanoClaw project. Modified by Sly Wombat.
#
# Build the SlyClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="slyclaw-agent"
TAG="${1:-latest}"

echo "Building SlyClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Docker, passing host UID/GID so container node user matches host user
docker build \
  --build-arg HOST_UID="$(id -u)" \
  --build-arg HOST_GID="$(id -g)" \
  -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"
