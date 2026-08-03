#!/bin/sh
# Run ON THE SERVER to deploy the latest code. One-time setup in DEPLOY.md.
#   cd ~/Caratland && ./deploy.sh
set -e

git pull --ff-only
npm install --omit=dev

# Restart if already running, otherwise start and register with pm2.
pm2 restart caratland 2>/dev/null || pm2 start server.mjs --name caratland
pm2 save

echo "Deployed $(git rev-parse --short HEAD)"
