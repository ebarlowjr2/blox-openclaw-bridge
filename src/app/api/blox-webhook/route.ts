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
  role?: 'ceo' | 'agent';
  agent?: string;
  companyProfile?: CompanyProfile;
}

type SessionRecord = {
  sessionKey: string;
  workstreamId?: string;
  updatedAt: string;
};

interface OpenClawAgentJson {
  ok?: boolean;
  reply?: string;
  message?: string;
  sessionId?: string;
  sessionKey?: string;
  [key: string]: unknown;
}

const sessions = new Map<string, SessionRecord>();

function getBearerToken(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

function getSessionKey(workstreamId?: string, sessionKey?: string) {
  if (sessionKey) return sessionKey;
  if (!workstreamId) return 'blox-default';
  const existing = sessions.get(workstreamId);
  if (existing) return existing.sessionKey;
  return `blox-${workstreamId}`;
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
  ].filter(Boolean);

  return lines.join('\n');
}

async function runOpenClawSession(sessionKey: string, prompt: string) {
  const relayUrl = process.env.BLOX_RELAY_URL;
  if (relayUrl) {
    return runRelaySession(relayUrl, sessionKey, prompt);
  }

  const timeoutSeconds = Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS || 45);
  const args = ['agent', '--to', sessionKey, '--message', prompt, '--json', '--timeout', String(timeoutSeconds)];

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
  if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
    return parsed.reply.trim();
  }
  if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim();
  }
  return stdout.trim() || 'OpenClaw returned no reply.';
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

  const sessionKey = getSessionKey(body.workstreamId, body.sessionKey);
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
          summary: 'Forwarded request into a dedicated OpenClaw session.',
        },
      ],
      metadata: {
        sessionKey,
        transport: result.transport,
        sessionId: result.parsed?.sessionId ?? null,
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
  });
}
