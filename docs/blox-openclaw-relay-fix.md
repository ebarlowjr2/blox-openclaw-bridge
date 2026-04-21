# BLOX ↔ OpenClaw Relay Isolation Fix

## Summary

The BLOX web chat relay previously routed every request through the operator's
live `main` OpenClaw agent (session key `agent:main:main`). When the main
Telegram/control session was active, the relay's `openclaw agent` call would
block on the main agent's `.jsonl.lock`, fail with
`session file locked (timeout 10000ms)`, and then fall through to a broken
fallback alias (`openai-codex/custom-1`), killing the turn.

This change isolates the BLOX web lane end-to-end and replaces the broken
fallback with a fully-qualified model id.

## Root cause (as observed in the live main session log)

1. Relay invocation did not specify an agent id, so OpenClaw routed to `main`.
2. The main agent already held an exclusive write lock on its session jsonl.
3. The BLOX request waited out the lock timeout, then asked the model
   fallback chain to take over.
4. The configured fallback (`custom-1`) was a bare alias. OpenClaw's resolver
   concatenates the active provider prefix onto unqualified aliases, producing
   `openai-codex/custom-1` — which does not exist. The turn died.

## Fix

### Host side (`~/.openclaw/openclaw.json`)

- `agents.defaults.model.fallbacks`
  - before: `["custom-1"]` (resolves to non-existent `openai-codex/custom-1`)
  - after:  `["bedrock/global.anthropic.claude-sonnet-4-6"]`
- Created a dedicated `blox` agent with its own workspace, agent dir, and
  session store:
  - workspace: `~/.openclaw/agents/blox/workspace`
  - agent dir: `~/.openclaw/agents/blox/agent`
  - sessions:  `~/.openclaw/agents/blox/sessions`
- Bootstrap files under the BLOX workspace declare the BLOX persona,
  session-key contract, and memory/wiki scope so BLOX never reads from
  `main`'s workspace.

### Relay (`relay/server.mjs`)

- Invocation always passes `--agent ${BLOX_RELAY_AGENT_ID || 'blox'}`, so
  OpenClaw can never route the request to `main` even if routing bindings
  change upstream.
- Startup validation refuses to boot if `BLOX_RELAY_AGENT_ID === 'main'`.
- Request-time guardrails:
  - reject blank / missing `sessionKey`
  - reject `agent:main:main`, `main`, `agent:main`
  - require prefix `blox:` or `blox-`
- `/health` reports the resolved agent id, session namespace, accepted
  prefixes, and forbidden keys so callers can verify isolation in production.

### Bridge (`src/app/api/blox-webhook/route.ts`)

- Direct-host transport also passes `--agent ${BLOX_OPENCLAW_AGENT_ID || 'blox'}`.
- Deterministic session keys built from tenant/user/thread ids:
  `blox:web:<tenantId>:<userId>:<threadId>`. Fallbacks preserve BLOX
  prefixing (`blox:web:workstream:<userId>:<workstreamId>`,
  `blox:web:default:anon:default`).
- Incoming `body.sessionKey` values are only honored if they already carry
  a BLOX prefix; anything else is rejected with `VALIDATION_ERROR` instead
  of being laundered into the main lane.
- `GET /api/blox-webhook` now surfaces the resolved agent id, namespace,
  and accepted prefixes for cheap sanity checks from Vercel logs.

## Session key contract

| Context | Format |
| --- | --- |
| Thread-scoped | `blox:web:<tenantId>:<userId>:<threadId>` |
| Workstream fallback | `blox:web:workstream:<userId>:<workstreamId>` |
| Last-resort default | `blox:web:default:anon:default` |
| Legacy (accepted) | `blox-<workstreamId>` |
| Rejected | `agent:main:main`, anything not prefixed with `blox:` / `blox-` |

## Environment variables

| Var | Scope | Purpose |
| --- | --- | --- |
| `BLOX_OPENCLAW_AGENT_ID` | Vercel bridge (direct-host transport) | Overrides the agent id passed to `openclaw agent --agent`. Defaults to `blox`. |
| `BLOX_RELAY_AGENT_ID`    | Host relay | Same as above, for `relay/server.mjs`. Defaults to `blox`. Relay refuses to start if set to `main`. |
| `BLOX_RELAY_URL`         | Vercel bridge | Optional. When set, the bridge forwards to the host relay instead of executing `openclaw` locally. |
| `BLOX_RELAY_BEARER`      | Both | Shared bearer for the relay endpoint. |
| `OPENCLAW_AGENT_TIMEOUT_SECONDS` | Both | CLI timeout (seconds). Default 45. |

## Validation

The following validation matrix is run after deployment:

1. **Lock-collision isolation** — with an active `main` Telegram session, a
   BLOX web chat call MUST NOT touch
   `~/.openclaw/agents/main/sessions/*.jsonl.lock`.
2. **BLOX continuity** — two messages in the same BLOX thread map to the
   same session key and inherit prior context.
3. **Fallback sanity** — `openai-codex/custom-1` does not appear in
   `~/.openclaw/openclaw.json`; a primary-model failure falls through to
   `bedrock/global.anthropic.claude-sonnet-4-6` and succeeds.
4. **Reload safety** — reloading the BLOX GUI and continuing the same
   thread resumes the same BLOX session key.

## Operator runbook (host EC2)

```sh
# 1. Freeze gateway before touching session state
systemctl --user stop openclaw-gateway

# 2. Verify fallback chain is healthy
python3 -c "import json;d=json.load(open('~/.openclaw/openclaw.json'.replace('~','/home/ubuntu')));print(d['agents']['defaults']['model'])"

# 3. Confirm blox agent is present
openclaw agents list

# 4. (Re)start gateway
systemctl --user start openclaw-gateway
systemctl --user is-active openclaw-gateway

# 5. Restart relay with the new code
pkill -f 'node .*relay/server.mjs' || true
cd ~/.openclaw/workspace/blox-openclaw-bridge/relay && \
  nohup env \
    PORT=8787 \
    BLOX_RELAY_BEARER="$BLOX_RELAY_BEARER" \
    BLOX_RELAY_AGENT_ID=blox \
    OPENCLAW_AGENT_TIMEOUT_SECONDS=45 \
    node server.mjs > ~/.openclaw/logs/blox-relay.log 2>&1 &

# 6. Health check
curl -s http://127.0.0.1:8787/health | python3 -m json.tool
```
