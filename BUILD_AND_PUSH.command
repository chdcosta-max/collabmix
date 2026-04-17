#!/bin/bash
cd "$(dirname "$0")"
echo "=== Building CollabMix ==="
npm run build
echo "=== Deploying to Vercel ==="
npx --yes vercel --prod --yes
echo "=== Done ==="
