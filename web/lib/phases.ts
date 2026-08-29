/**
 * Tool name -> workflow phase.
 *
 * The agent is one long awaited call with no events of its own, so the only
 * live progress signal available is which MCP tool it is currently calling.
 * That turns out to be enough: the tool vocabulary maps cleanly onto the six
 * stages a human cares about, which are exactly the steps in the sidebar rail.
 */

export const PHASES = [
  'discovery',
  'planning',
  'sandbox',
  'approval',
  'execution',
  'certificate',
] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_LABELS: Record<Phase, string> = {
  discovery: 'Discovery',
  planning: 'Planning',
  sandbox: 'Sandbox',
  approval: 'Approval',
  execution: 'Execution',
  certificate: 'Certificate',
};

const SANDBOX_TOOLS = new Set([
  'db_export_subject_snapshot',
  'db_stage_deletion_actions',
  'db_rehearse_deletion_plan',
  'db_delete_snapshot',
]);

/**
 * Sandbox tools are also `db_`-prefixed, so they must be tested before the
 * general discovery fallback or a rehearsal would report as discovery.
 */
export function phaseForTool(tool: string): Phase {
  if (SANDBOX_TOOLS.has(tool)) return 'sandbox';
  if (tool === 'plan_create') return 'planning';
  if (tool === 'plan_approve') return 'approval';
  if (tool === 'oubliette_execute_erasure') return 'execution';
  return 'discovery';
}

/** Ordering helper so a phase can never appear to move backwards. */
export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}
