import { proxyToGateway } from '@/lib/gateway-proxy';

/** Every /api/v1/auth/* call goes through the web origin, so the refresh cookie is first-party (Phase 11b). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const GET = proxyToGateway;
export const POST = proxyToGateway;
export const DELETE = proxyToGateway;
