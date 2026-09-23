export function audit(db, orgId, userId, action, detail) {
  db.prepare('INSERT INTO audit_log(org_id,user_id,ts,action,detail) VALUES(?,?,?,?,?)')
    .run(orgId, userId || null, Date.now(), action, typeof detail === 'string' ? detail : JSON.stringify(detail || {}));
}
