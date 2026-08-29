import { NextResponse } from 'next/server';
import { caseGet } from '@/lib/mcp';
import { approveRun, pausedRunFor } from '@/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The human-in-the-loop gate.
 *
 * This route does not delete anything and does not decide what may be deleted.
 * It records who approved, then hands the case id, plan hash, and approver to
 * the agent. Oubliette re-derives the canonical hash from the stored plan,
 * checks it against the one submitted here, confirms the approval row belongs
 * to the current case revision, and refuses if any of that disagrees - so a
 * plan that changed after the operator looked at it cannot be executed by
 * replaying this request.
 */
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;

  let body: { plan_hash?: unknown; approved_by?: unknown; run_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const planHash = typeof body.plan_hash === 'string' ? body.plan_hash : '';
  const approvedBy = typeof body.approved_by === 'string' ? body.approved_by.trim() : '';
  const runId = typeof body.run_id === 'string' ? body.run_id : null;
  if (!/^[0-9a-f]{64}$/.test(planHash)) {
    return NextResponse.json({ error: 'plan_hash must be a 64-character sha256 hex digest' }, { status: 400 });
  }
  if (!approvedBy) {
    return NextResponse.json({ error: 'approved_by is required' }, { status: 400 });
  }

  // Fail fast with a readable message when the operator is looking at a stale
  // page. This is a courtesy check only - the authoritative refusal happens
  // inside Oubliette, which re-validates independently of anything sent here.
  try {
    const record = await caseGet(caseId);
    if (!record) return NextResponse.json({ error: `case not found: ${caseId}` }, { status: 404 });
    const latest = record.plans.at(-1);
    if (!latest) return NextResponse.json({ error: 'case has no plan to approve' }, { status: 409 });
    if (latest.plan_hash !== planHash) {
      return NextResponse.json(
        { error: 'plan has changed since it was displayed; reload the case and review it again' },
        { status: 409 },
      );
    }
    if (record.certificate) {
      return NextResponse.json({ error: 'this case has already been executed' }, { status: 409 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'failed to read case' },
      { status: 502 },
    );
  }

  // On the harness the agent is paused mid-turn holding the plan it built, and
  // approving resumes that turn; the deterministic engine has already returned,
  // so approving starts execution. The caller passes the run it is looking at
  // and approveRun picks the right route.
  const run = approveRun(pausedRunFor(runId), {
    case_id: caseId, plan_hash: planHash, approved_by: approvedBy,
  });
  return NextResponse.json({ run_id: run.run_id }, { status: 202 });
}
