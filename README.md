# blox-openclaw-bridge

Vercel-hosted bridge for BLOX web chat.

## Endpoint
- `POST /api/blox-webhook`
- `GET /api/blox-webhook`

## Required env vars
- `BLOX_WEBHOOK_BEARER`
- `OPENCLAW_AGENT_TIMEOUT_SECONDS` (optional; default `45` for the Vercel bridge so it fits inside Vercel's invocation limit, `120` on the host relay where there's no platform cap and the first BLOX turn runs skill bootstrap + memory hooks)
- `BLOX_OPENCLAW_AGENT_ID` (optional, default `blox`) — agent id passed to `openclaw agent --agent` from the bridge
- `BLOX_RELAY_AGENT_ID` (optional, default `blox`) — same override for the host relay; relay refuses to start if set to `main`
- `BLOX_RELAY_URL` (optional, use host relay from Vercel)
- `BLOX_RELAY_BEARER` (optional, auth for host relay)

## Purpose
Receives BLOX chat webhook requests and forwards them into the OpenClaw transport layer.

## Current status
- auth implemented
- payload validation implemented
- workstream to session mapping implemented
- direct host-side OpenClaw transport implemented
- optional host relay scaffold added for Vercel style deployments

## Local development

```bash
npm install
npm run dev
```

Then open:
- `http://localhost:3000`
- `http://localhost:3000/api/blox-webhook`

## Host relay

A small host relay is included in `./relay` for deployments where the public bridge cannot execute `openclaw` directly.

Start it on the OpenClaw host:

```bash
cd relay
PORT=8787 BLOX_RELAY_BEARER=replace-me node server.mjs
```

Endpoints:
- `GET /health`
- `POST /relay`

Relay request body:

```json
{
  "sessionKey": "blox-sales",
  "message": "Handle this BLOX chat request"
}
```

Recommended architecture:
- Vercel bridge receives public webhook traffic
- bridge calls host relay over HTTPS with `BLOX_RELAY_URL`
- relay executes `openclaw agent --agent blox --to <sessionKey> --message <prompt> --json`
- relay returns assistant reply to the bridge

Session keys must start with `blox:` or `blox-` and must not equal
`agent:main:main` / `main` / `agent:main`. See
[`docs/blox-openclaw-relay-fix.md`](docs/blox-openclaw-relay-fix.md) for the
full session-key contract, operator runbook, and validation matrix.
