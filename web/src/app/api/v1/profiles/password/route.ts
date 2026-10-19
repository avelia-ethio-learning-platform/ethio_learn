import { proxyToGateway } from '@/lib/gateway-proxy';

/** The password change issues a fresh refresh cookie, so it lands on the web host too (Phase 11b, B1). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const PUT = proxyToGateway;
