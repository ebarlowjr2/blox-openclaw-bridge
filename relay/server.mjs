import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const port = Number(process.env.PORT || 8787);
const bearer = process.env.BLOX_RELAY_BEARER || '';
const timeoutSeconds = Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS || 120);
const agentId = (process.env.BLOX_RELAY_AGENT_ID || 'blox').trim();

const ACCEPTED_SESSION_PREFIXES = ['blox:', 'blox-'];
const SESSION_NAMESPACE = 'blox:web';
const FORBIDDEN_SESSION_KEYS = new Set(['agent:main:main', 'main', 'agent:main']);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function parseAgentJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf('\n{');
    const candidate = start >= 0 ? trimmed.slice(start + 1) : trimmed;
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

function extractReply(parsed, stdout) {
  if (parsed) {
    const payloads = Array.isArray(parsed.result?.payloads) ? parsed.result.payloads : null;
    if (payloads) {
      const text = payloads
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .filter((t) => t.trim().length > 0)
        .join('\n\n')
        .trim();
      if (text) return text;
    }

    const visible = parsed.result?.meta?.finalAssistantVisibleText;
    if (typeof visible === 'string' && visible.trim()) return visible.trim();

    if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
      return parsed.reply.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  }
  return stdout.trim() || 'OpenClaw returned no reply.';
}

function extractSessionId(parsed) {
  if (!parsed) return null;
  return (
    parsed.result?.meta?.agentMeta?.sessionId ??
    parsed.result?.meta?.sessionId ??
    parsed.sessionId ??
    null
  );
}

function validateSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== 'string') {
    return { ok: false, error: 'sessionKey is required.' };
  }
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return { ok: false, error: 'sessionKey must not be blank.' };
  }
  if (FORBIDDEN_SESSION_KEYS.has(trimmed.toLowerCase())) {
    return {
      ok: false,
      error: `sessionKey "${trimmed}" is reserved for the main agent lane and is not routable through the BLOX relay.`,
    };
  }
  const acceptable = ACCEPTED_SESSION_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  if (!acceptable) {
    return {
      ok: false,
      error: `sessionKey must start with one of: ${ACCEPTED_SESSION_PREFIXES.join(', ')} (got "${trimmed}").`,
    };
  }
  return { ok: true, sessionKey: trimmed };
}

async function runOpenClaw({ sessionKey, message }) {
  const args = [
    'agent',
    '--agent',
    agentId,
    '--to',
    sessionKey,
    '--message',
    message,
    '--json',
    '--timeout',
    String(timeoutSeconds),
  ];
  const { stdout, stderr } = await execFileAsync('openclaw', args, {
    timeout: (timeoutSeconds + 5) * 1000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });

  const parsed = parseAgentJson(stdout);
  return {
    reply: extractReply(parsed, stdout),
    parsed,
    stdout,
    stderr,
  };
}

async function startupValidation() {
  if (agentId === 'main') {
    throw new Error(
      'BLOX relay refuses to start with BLOX_RELAY_AGENT_ID="main". The BLOX relay must never route to the main agent lane.',
    );
  }
  try {
    const { stdout } = await execFileAsync('openclaw', ['--version'], { timeout: 5000 });
    console.log(`[blox-relay] openclaw CLI detected: ${stdout.trim()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[blox-relay] WARNING: openclaw CLI check failed: ${message}`);
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'blox-openclaw-relay',
      agentId,
      sessionNamespace: SESSION_NAMESPACE,
      acceptedSessionPrefixes: ACCEPTED_SESSION_PREFIXES,
      forbiddenSessionKeys: Array.from(FORBIDDEN_SESSION_KEYS),
      timeoutSeconds,
    });
  }

  if (req.method !== 'POST' || req.url !== '/relay') {
    return sendJson(res, 404, { ok: false, error: 'Not found.' });
  }

  if (bearer) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7).trim() !== bearer) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized.' });
    }
  }

  try {
    const body = await readJsonBody(req);
    const validation = validateSessionKey(body.sessionKey);
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null;

    if (!validation.ok) {
      return sendJson(res, 400, {
        ok: false,
        error: validation.error,
        agentId,
      });
    }
    if (!message) {
      return sendJson(res, 400, {
        ok: false,
        error: 'message is required.',
        agentId,
      });
    }

    const sessionKey = validation.sessionKey;
    const result = await runOpenClaw({ sessionKey, message });
    return sendJson(res, 200, {
      ok: true,
      reply: result.reply,
      sessionKey,
      agentId,
      metadata: {
        transport: 'openclaw-agent-relay',
        agentId,
        sessionId: extractSessionId(result.parsed),
        rawOk: result.parsed?.ok ?? null,
      },
    });
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown relay error.',
      agentId,
    });
  }
});

startupValidation()
  .then(() => {
    server.listen(port, () => {
      console.log(
        `[blox-relay] listening on :${port} agent=${agentId} namespace=${SESSION_NAMESPACE} prefixes=${ACCEPTED_SESSION_PREFIXES.join(
          '|',
        )}`,
      );
    });
  })
  .catch((error) => {
    console.error(`[blox-relay] startup failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
