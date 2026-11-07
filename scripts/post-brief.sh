#!/usr/bin/env bash
# Post a Markdown brief to the portal as a DRAFT for admin review.
# Usage: PORTAL_URL=https://news.example.com INGEST_API_KEY=... ./scripts/post-brief.sh brief.md [YYYY-MM-DD]
set -euo pipefail
FILE="${1:?markdown file required}"
DATE="${2:-$(TZ=Asia/Kolkata date +%F)}"
BODY=$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({date:process.argv[2],markdown:fs.readFileSync(process.argv[1],"utf8")}))' "$FILE" "$DATE")
curl -sS -X POST "${PORTAL_URL:?set PORTAL_URL}/api/ingest" \
  -H "Authorization: Bearer ${INGEST_API_KEY:?set INGEST_API_KEY}" \
  -H "Content-Type: application/json" \
  --data "$BODY"
echo
