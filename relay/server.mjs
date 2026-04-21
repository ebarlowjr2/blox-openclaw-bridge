import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 8787);
const bearer = process.env.BLOX_RELAY_BEARER || '';
const timeoutSeconds = Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS || 45);

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
  if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
    return parsed.reply.trim();
  }
  if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim();
  }
  return stdout.trim() || 'OpenClaw returned no reply.';
}

async function runOpenClaw({ sessionKey, message }) {
  const args = ['agent', '--to', sessionKey, '--message', message, '--json', '--timeout', String(timeoutSeconds)];
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

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, service: 'blox-openclaw-relay' });
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
    const sessionKey = typeof body.sessionKey === 'string' && body.sessionKey.trim() ? body.sessionKey.trim() : null;
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null;

    if (!sessionKey || !message) {
      return sendJson(res, 400, {
        ok: false,
        error: 'sessionKey and message are required.',
      });
    }

    const result = await runOpenClaw({ sessionKey, message });
    return sendJson(res, 200, {
      ok: true,
      reply: result.reply,
      sessionKey,
      metadata: {
        transport: 'openclaw-agent-relay',
        sessionId: result.parsed?.sessionId ?? null,
        rawOk: result.parsed?.ok ?? null,
      },
    });
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown relay error.',
    });
  }
});

server.listen(port, () => {
  console.log(`blox-openclaw-relay listening on :${port}`);
});
