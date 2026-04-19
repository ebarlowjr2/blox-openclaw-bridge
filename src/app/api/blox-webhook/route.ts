import { NextRequest, NextResponse } from 'next/server';

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
  const reply = [
    `Bridge online. Session ${sessionKey} received your message.`,
    `Role: ${body.role || 'ceo'}`,
    body.agent ? `Requested agent: ${body.agent}` : null,
    `Message: "${body.message.trim()}"`,
    `Context: ${context}`,
    '',
    'Next step: wire this Vercel bridge to the real OpenClaw runtime.',
  ]
    .filter(Boolean)
    .join('\n');

  return NextResponse.json({
    success: true,
    reply,
    sessionKey,
    toolsUsed: [
      {
        agentName: 'Bridge',
        toolKey: 'webhook',
        summary: 'Accepted request through Vercel bridge.',
      },
    ],
    metadata: {
      sessionKey,
      transport: 'bridge-mock',
    },
  });
}

export async function GET() {
  return NextResponse.json({
    success: true,
    ok: true,
    message: 'BLOX OpenClaw bridge is running.',
  });
}
