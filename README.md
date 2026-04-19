# blox-openclaw-bridge

Vercel-hosted bridge for BLOX web chat.

## Endpoint
- `POST /api/blox-webhook`
- `GET /api/blox-webhook`

## Required env vars
- `BLOX_WEBHOOK_BEARER`

## Purpose
Receives BLOX chat webhook requests and forwards them into the OpenClaw transport layer.

## Current status
- auth implemented
- payload validation implemented
- session mapping placeholder implemented
- real OpenClaw runtime transport not wired yet

## Local development

```bash
npm install
npm run dev
```

Then open:
- `http://localhost:3000`
- `http://localhost:3000/api/blox-webhook`
