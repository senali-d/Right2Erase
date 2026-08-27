import { db, getCase, now } from './db.js';

export function executeCertificate({ caseId, planHash, approvedBy, manifest = [], withheld = [] }) {
  const subject = getCase(caseId);
  if (!subject) throw new Error(`case not found: ${caseId}`);
  const plan = db.prepare('SELECT * FROM plans WHERE case_id = ? AND plan_hash = ?').get(caseId, planHash);
  if (!plan) throw new Error('plan hash does not match a stored plan for this case');
  const approval = db.prepare('SELECT * FROM approvals WHERE case_id = ? AND plan_hash = ? ORDER BY id DESC LIMIT 1').get(caseId, planHash);
  if (!approval) throw new Error('the plan has not been approved');
  if (approval.approved_by !== approvedBy) throw new Error('approved_by does not match the approving identity');
  if (db.prepare('SELECT 1 FROM certificates WHERE case_id = ?').get(caseId)) throw new Error('case already has a certificate');

  const timestamp = now();
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO certificates (case_id, plan_hash, approved_by, manifest, withheld, executed_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(caseId, planHash, approvedBy, JSON.stringify(manifest), JSON.stringify(withheld), timestamp);
    db.prepare("UPDATE cases SET status = 'completed', updated_at = ? WHERE id = ?").run(timestamp, caseId);
  });
  transaction();
  return db.prepare('SELECT * FROM certificates WHERE case_id = ?').get(caseId);
}
