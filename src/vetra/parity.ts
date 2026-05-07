export function sqliteRowToParityShape(row: any) {
  return {
    dispatch_id: row.id,
    query_id: row.query_id,
    from_actor: row.from_actor,
    to_agent: row.to_agent,
    channel: row.channel,
    status: String(row.status).toUpperCase(),
    dispatched_at: new Date(row.dispatched_at).toISOString(),
    responded_at: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    verify_status: row.verify_status ? String(row.verify_status).toUpperCase() : null,
    verify_last_checked: row.verify_last_checked ? new Date(row.verify_last_checked).toISOString() : null,
    parent_dispatch_id: row.parent_dispatch_id,
    body_markdown: row.message,
    artifacts: row.artifact_path ? [{ path: row.artifact_path }] : [],
    verify_signal: row.verify_signal_json ? JSON.parse(row.verify_signal_json) : null,
    verify_failures: row.verify_failures_json ? JSON.parse(row.verify_failures_json) : null,
  };
}

export function diffParity(sqliteShape: any, vetraShape: any) {
  const drifts = [];
  for (const key of Object.keys(sqliteShape)) {
    if (JSON.stringify(sqliteShape[key]) !== JSON.stringify(vetraShape[key])) {
      drifts.push({ field: key, sqlite: sqliteShape[key], vetra: vetraShape[key] });
    }
  }
  return drifts;
}
