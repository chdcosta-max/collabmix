#!/bin/bash
cd "$(dirname "$0")"
echo "=== Building CollabMix ==="
npm run build
echo ""
echo "=== Logging in to Vercel (a browser tab will open — click Confirm) ==="
npx --yes vercel login
echo ""
echo "=== Deploying to Vercel ==="
npx vercel --prod --yes
echo ""
echo "=== Done! CollabMix is live ==="
