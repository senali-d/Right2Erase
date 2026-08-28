import { NextResponse } from 'next/server';
import { caseList } from '@/lib/mcp';
import { startPrepareRun } from '@/lib/agent-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ cases: await caseList() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'failed to list cases' },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  let body: { subject_email?: unknown; force?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const subjectEmail = typeof body.subject_email === 'string' ? body.subject_email.trim() : '';
  if (!subjectEmail) return NextResponse.json({ error: 'subject_email is required' }, { status: 400 });

  // Every prepare() run creates a new case, and Oubliette cases are permanent
  // audit records with no delete path. Opening a second case for the same
  // person by mistake is therefore unrecoverable clutter, so surface the
  // existing one and make the duplicate an explicit choice.
  if (body.force !== true) {
    try {
      const existing = (await caseList()).find((c) => c.subject_email === subjectEmail);
      if (existing) {
        return NextResponse.json(
          { existing_case: existing, error: `a case already exists for ${subjectEmail}` },
          { status: 409 },
        );
      }
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'failed to check existing cases' },
        { status: 502 },
      );
    }
  }

  const run = startPrepareRun(subjectEmail);
  return NextResponse.json({ run_id: run.run_id }, { status: 202 });
}
