/**
 * GET /api/assistant/mode: {planner, client} for the panel subtitle and checks
 * (SPEC-LIVE AC-L1). Only those two enum values: no key, no flags, no spend.
 */
import { NextResponse } from 'next/server';
import { modeInfo } from '@/lib/assistant/claude/config';

export const dynamic = 'force-dynamic';

export function GET() {
  const { planner, client } = modeInfo();
  return NextResponse.json({ planner, client }, { headers: { 'Cache-Control': 'no-store' } });
}
