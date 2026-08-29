import { NextResponse } from 'next/server';
import { getRun } from '@/lib/run-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The 1s poll target while an agent run is in flight. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const run = getRun(runId);
  if (!run)
    return NextResponse.json(
      { error: `run not found: ${runId}` },
      { status: 404 },
    );
  return NextResponse.json({ run });
}
