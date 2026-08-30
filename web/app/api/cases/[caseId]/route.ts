import { NextResponse } from 'next/server';
import { caseGet } from '@/lib/mcp';
import { buildCaseView } from '@/lib/case-view';
import { withEventDetail } from '@/lib/event-detail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;
  try {
    const record = await caseGet(caseId);
    if (!record)
      return NextResponse.json(
        { error: `case not found: ${caseId}` },
        { status: 404 },
      );
    return NextResponse.json({
      view: buildCaseView(await withEventDetail(record)),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'failed to read case' },
      { status: 502 },
    );
  }
}
