import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';

const execFileAsync = promisify(execFile);

interface CompanyProfile {
  companyName?: string;
  industry?: string;
  description?: string;
  services?: string;
  idealCustomer?: string;
  regions?: string;
  compliance?: string;
  tone?: string;
  glossary?: string;
  goals?: string;
  knowledgeDocs?: Array<{
    id: string;
    title: string;
    source: string;
    url: string;
    content: string;
  }>;
  agentTools?: Record<string, string[]>;
}

interface BridgeRequest {
  source?: string;
  sessionKey?: string;
  message?: string;
  channel?: 'web' | 'email' | 'sms';
  workstreamId?: string;
  tenantId?: string;
  userId?: string;
  threadId?: string;
  role?: 'ceo' | 'agent';
  agent?: string;
  companyProfile?: CompanyProfile;
}

const BLOX_AGENT_ID = process.env.BLOX_OPENCLAW_AGENT_ID?.trim() || 'blox';
const BLOX_SESSION_NAMESPACE = 'blox:web';
const ACCEPTED_SESSION_PREFIXES = ['blox:', 'blox-'] as const;
const FORBIDDEN_SESSION_KEYS = new Set(['agent:main:main', 'main', 'agent:main']);

type SessionRecord = {
  sessionKey: string;
  workstreamId?: string;
  updatedAt: string;
};

interface OpenClawAgentPayload {
  text?: string | null;
  mediaUrl?: string | null;
}

interface OpenClawAgentMeta {
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  agentMeta?: {
    sessionId?: string;
    provider?: string;
    model?: string;
  };
  sessionId?: string;
}

interface OpenClawAgentResult {
  payloads?: OpenClawAgentPayload[];
  meta?: OpenClawAgentMeta;
}

interface OpenClawAgentJson {
  ok?: boolean;
  reply?: string;
  message?: string;
  sessionId?: string;
  sessionKey?: string;
  status?: string;
  runId?: string;
  result?: OpenClawAgentResult;
  [key: string]: unknown;
}

const sessions = new Map<string, SessionRecord>();

function getBearerToken(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

function sanitizeSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'default';
}

function isAcceptableBloxKey(key: string) {
  if (FORBIDDEN_SESSION_KEYS.has(key.toLowerCase())) return false;
  return ACCEPTED_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function buildDeterministicKey(body: BridgeRequest) {
  const tenantId = body.tenantId ? sanitizeSegment(body.tenantId) : null;
  const userId = body.userId ? sanitizeSegment(body.userId) : null;
  const threadId = body.threadId ? sanitizeSegment(body.threadId) : null;
  if (tenantId && userId && threadId) {
    return `${BLOX_SESSION_NAMESPACE}:${tenantId}:${userId}:${threadId}`;
  }
  if (body.workstreamId) {
    const ws = sanitizeSegment(body.workstreamId);
    const user = userId ?? 'anon';
    return `${BLOX_SESSION_NAMESPACE}:workstream:${user}:${ws}`;
  }
  return `${BLOX_SESSION_NAMESPACE}:default:anon:default`;
}

function getSessionKey(body: BridgeRequest) {
  const candidate = body.sessionKey?.trim();
  if (candidate && isAcceptableBloxKey(candidate)) {
    return { sessionKey: candidate };
  }
  if (candidate) {
    return {
      sessionKey: null,
      error: `sessionKey "${candidate}" is not routable through the BLOX agent; must start with one of: ${ACCEPTED_SESSION_PREFIXES.join(', ')} and must not equal ${Array.from(
        FORBIDDEN_SESSION_KEYS,
      ).join(', ')}.`,
    };
  }
  if (body.workstreamId) {
    const existing = sessions.get(body.workstreamId);
    if (existing && isAcceptableBloxKey(existing.sessionKey)) {
      return { sessionKey: existing.sessionKey };
    }
  }
  return { sessionKey: buildDeterministicKey(body) };
}

function saveSession(workstreamId: string | undefined, sessionKey: string) {
  if (!workstreamId) return;
  sessions.set(workstreamId, {
    sessionKey,
    workstreamId,
    updatedAt: new Date().toISOString(),
  });
}

function buildContext(profile?: CompanyProfile) {
  if (!profile) return 'No company profile provided.';
  const parts = [
    profile.companyName ? `Company: ${profile.companyName}` : null,
    profile.industry ? `Industry: ${profile.industry}` : null,
    profile.services ? `Services: ${profile.services}` : null,
    profile.idealCustomer ? `ICP: ${profile.idealCustomer}` : null,
    profile.tone ? `Tone: ${profile.tone}` : null,
    profile.goals ? `Goals: ${profile.goals}` : null,
  ].filter(Boolean);

  const docs = profile.knowledgeDocs?.slice(0, 2).map((doc) => doc.title) || [];
  if (docs.length) {
    parts.push(`Knowledge docs: ${docs.join(', ')}`);
  }

  return parts.length ? parts.join(' | ') : 'Company profile provided but mostly empty.';
}

function buildOpenClawPrompt(body: BridgeRequest, context: string) {
  const lines = [
    'You are handling a BLOX web chat request.',
    `Session key: ${body.sessionKey || 'not provided'}`,
    `Workstream: ${body.workstreamId || 'default'}`,
    `Role: ${body.role || 'ceo'}`,
    body.agent ? `Requested agent: ${body.agent}` : null,
    `Channel: ${body.channel || 'web'}`,
    `Company context: ${context}`,
    '',
    'User message:',
    body.message?.trim() || '',
  ].filter((line): line is string => line !== null);

  return lines.join('\n');
}

async function runOpenClawSession(sessionKey: string, prompt: string) {
  const relayUrl = process.env.BLOX_RELAY_URL;
  if (relayUrl) {
    return runRelaySession(relayUrl, sessionKey, prompt);
  }

  const timeoutSeconds = Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS || 45);
  const args = [
    'agent',
    '--agent',
    BLOX_AGENT_ID,
    '--to',
    sessionKey,
    '--message',
    prompt,
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
  const reply = extractReply(parsed, stdout);

  return {
    reply,
    parsed,
    stdout,
    stderr,
    transport: 'openclaw-agent',
  };
}

async function runRelaySession(relayUrl: string, sessionKey: string, prompt: string) {
  const response = await fetch(relayUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.BLOX_RELAY_BEARER
        ? { authorization: `Bearer ${process.env.BLOX_RELAY_BEARER}` }
        : {}),
    },
    body: JSON.stringify({
      sessionKey,
      message: prompt,
    }),
    cache: 'no-store',
  });

  const payload = (await response.json()) as {
    ok?: boolean;
    reply?: string;
    metadata?: OpenClawAgentJson;
    error?: string;
  };

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Relay request failed with status ${response.status}.`);
  }

  return {
    reply: payload.reply || 'OpenClaw relay returned no reply.',
    parsed: payload.metadata || null,
    stdout: '',
    stderr: '',
    transport: 'openclaw-agent-relay',
  };
}

function parseAgentJson(stdout: string): OpenClawAgentJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as OpenClawAgentJson;
  } catch {
    const start = trimmed.lastIndexOf('\n{');
    const candidate = start >= 0 ? trimmed.slice(start + 1) : trimmed;
    try {
      return JSON.parse(candidate) as OpenClawAgentJson;
    } catch {
      return null;
    }
  }
}

function extractReply(parsed: OpenClawAgentJson | null, stdout: string) {
  if (parsed) {
    const payloads = Array.isArray(parsed.result?.payloads) ? parsed.result.payloads : null;
    const payloadText = payloads
      ?.map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter((t) => t.trim().length > 0)
      .join('\n\n')
      .trim();
    if (payloadText) return payloadText;

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

function extractSessionId(parsed: OpenClawAgentJson | null): string | null {
  if (!parsed) return null;
  return (
    parsed.result?.meta?.agentMeta?.sessionId ??
    parsed.result?.meta?.sessionId ??
    parsed.sessionId ??
    null
  );
}

export async function POST(req: NextRequest) {
  const expectedBearer = process.env.BLOX_WEBHOOK_BEARER;

  if (expectedBearer) {
    const suppliedBearer = getBearerToken(req);
    if (!suppliedBearer || suppliedBearer !== expectedBearer) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid webhook bearer token.',
          },
        },
        { status: 401 }
      );
    }
  }

  const body = (await req.json()) as BridgeRequest;

  if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Message is required.',
        },
      },
      { status: 400 }
    );
  }

  const resolved = getSessionKey(body);
  if (!resolved.sessionKey) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: resolved.error ?? 'Invalid session key.',
        },
      },
      { status: 400 }
    );
  }
  const sessionKey = resolved.sessionKey;
  saveSession(body.workstreamId, sessionKey);

  const context = buildContext(body.companyProfile);
  const prompt = buildOpenClawPrompt({ ...body, sessionKey }, context);

  try {
    const result = await runOpenClawSession(sessionKey, prompt);

    return NextResponse.json({
      success: true,
      reply: result.reply,
      sessionKey,
      toolsUsed: [
        {
          agentName: 'OpenClaw',
          toolKey: 'openclaw-agent',
          summary: 'Forwarded request into the isolated BLOX OpenClaw agent session.',
        },
      ],
      metadata: {
        sessionKey,
        agentId: BLOX_AGENT_ID,
        sessionNamespace: BLOX_SESSION_NAMESPACE,
        transport: result.transport,
        sessionId: extractSessionId(result.parsed),
        rawOk: result.parsed?.ok ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown OpenClaw bridge error.';

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'OPENCLAW_EXEC_ERROR',
          message,
        },
        sessionKey,
      },
      { status: 502 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    ok: true,
    message: 'BLOX OpenClaw bridge is running.',
    agentId: BLOX_AGENT_ID,
    sessionNamespace: BLOX_SESSION_NAMESPACE,
    acceptedSessionPrefixes: ACCEPTED_SESSION_PREFIXES,
    forbiddenSessionKeys: Array.from(FORBIDDEN_SESSION_KEYS),
    transport: process.env.BLOX_RELAY_URL ? 'openclaw-agent-relay' : 'openclaw-agent',
  });
}
