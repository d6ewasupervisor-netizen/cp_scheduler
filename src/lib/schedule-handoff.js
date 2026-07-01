'use strict';

const { PROJECT_ID, PROJECT_NAME } = require('./constants');
const { dateToDayOfWeek } = require('./fiscal-calendar');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildHandoffJson(payload) {
  return {
    schemaVersion: '1.0',
    status: payload.status || 'approved',
    approvedAt: payload.approvedAt || null,
    approvedBy: payload.approvedBy || null,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    rep: payload.rep,
    week: payload.week,
    masterRouteVersion: payload.masterRouteVersion,
    placements: payload.placements,
    prodComparison: payload.prodComparison || [],
    warnings: payload.warnings || [],
    agentInstructions: {
      skill: 'sas-prod-shift-management-har',
      mode: 'execute-approved-schedule',
      rules: [
        'assertVisitStore on every mutation',
        'no duplicate visits for same store/date/project',
        'project 9293 only',
      ],
    },
  };
}

function buildHandoffMarkdown(json) {
  const lines = [];
  lines.push('---');
  lines.push(`rep: ${json.rep.name}`);
  lines.push(`week: ${json.week.label}`);
  lines.push(`projectId: ${json.projectId}`);
  lines.push(`approvedAt: ${json.approvedAt}`);
  lines.push(`approvedBy: ${json.approvedBy}`);
  lines.push('---');
  lines.push('');
  lines.push('# Central Pet Schedule Handoff');
  lines.push('');
  lines.push(`**Rep:** ${json.rep.name} (district ${json.rep.district})`);
  lines.push(`**Week:** ${json.week.label} (${json.week.start} – ${json.week.end})`);
  lines.push(`**Master Route version:** ${json.masterRouteVersion}`);
  lines.push(`**Approved:** ${json.approvedAt} by ${json.approvedBy}`);
  lines.push('');

  if (json.rep?.isD8Pool) {
    lines.push('## D8 proposed assignees (planning only)');
    lines.push('');
    lines.push('No notifications are sent. Pick one proposed assignee per visit in the app.');
    lines.push('');
    for (const a of json.rep.proposedAssignees || []) {
      lines.push(`- ${a.name}`);
    }
    lines.push('');
  }

  lines.push('## Week grid');
  lines.push('');
  const showAssignee = json.rep?.isD8Pool || json.placements.some((p) => p.proposedAssignee);
  if (showAssignee) {
    lines.push('| Date | DOW | Store | Proposed assignee | Account | Action | Start–End | MR OK |');
    lines.push('|------|-----|-------|-------------------|---------|--------|-----------|-------|');
  } else {
    lines.push('| Date | DOW | Store | Account | Action | Start–End | MR OK |');
    lines.push('|------|-----|-------|---------|--------|-----------|-------|');
  }
  for (const p of json.placements) {
    if (showAssignee) {
      lines.push(
        `| ${p.scheduledDate} | ${p.dayOfWeek} | ${p.storeNum} | ${p.proposedAssignee || '—'} | ${p.account || ''} | ${p.action || ''} | ${p.shiftStart}–${p.shiftEnd} | ${p.masterRouteValid ? 'yes' : 'NO'} |`
      );
    } else {
      lines.push(
        `| ${p.scheduledDate} | ${p.dayOfWeek} | ${p.storeNum} | ${p.account || ''} | ${p.action || ''} | ${p.shiftStart}–${p.shiftEnd} | ${p.masterRouteValid ? 'yes' : 'NO'} |`
      );
    }
  }
  lines.push('');

  lines.push('## Mutations required');
  lines.push('');
  json.placements.forEach((p, i) => {
    const delta = p.prodDelta?.type || 'create';
    lines.push(
      `${i + 1}. **${delta.toUpperCase()}** store ${p.storeNum} on ${p.scheduledDate} (${p.dayOfWeek})` +
        (p.prodDelta?.existingVisitId ? ` — visit ${p.prodDelta.existingVisitId}` : '')
    );
  });
  lines.push('');

  lines.push('## Master Route compliance');
  lines.push('');
  for (const p of json.placements) {
    lines.push(
      `- Store ${p.storeNum}: chose **${p.dayOfWeek}**; allowed **${(p.masterRoute?.allowedDays || []).join(', ')}** — ${p.masterRouteValid ? 'PASS' : 'FAIL'}`
    );
  }
  lines.push('');

  if (json.warnings?.length) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of json.warnings) lines.push(`- ${w.message}`);
    lines.push('');
  }

  lines.push('## PROD delta');
  lines.push('');
  for (const p of json.placements) {
    lines.push(`- Store ${p.storeNum} ${p.scheduledDate}: ${p.prodDelta?.type || 'unknown'}`);
  }
  lines.push('');

  lines.push('## Embedded JSON');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(json, null, 2));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function buildReviewHtml(json) {
  const showAssignee = json.rep?.isD8Pool || json.placements.some((p) => p.proposedAssignee);
  const rows = json.placements
    .map((p) => {
      const assigneeCell = showAssignee
        ? `<td>${escapeHtml(p.proposedAssignee || '—')}</td>`
        : '';
      return `<tr><td>${escapeHtml(p.scheduledDate)}</td><td>${escapeHtml(p.dayOfWeek)}</td><td>${p.storeNum}</td>${assigneeCell}<td>${escapeHtml(p.account)}</td><td>${escapeHtml(p.action)}</td><td>${escapeHtml(p.shiftStart)}–${escapeHtml(p.shiftEnd)}</td><td class="${p.masterRouteValid ? 'ok' : 'bad'}">${p.masterRouteValid ? 'PASS' : 'FAIL'}</td></tr>`;
    })
    .join('');

  const warnings = (json.warnings || [])
    .map((w) => `<li>${escapeHtml(w.message)}</li>`)
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Schedule Review — ${escapeHtml(json.rep.name)} ${escapeHtml(json.week.label)}</title>
<style>
body{background:#0d1117;color:#e6edf3;font-family:Segoe UI,system-ui,sans-serif;margin:2rem;max-width:960px}
h1,h2{color:#58a6ff}table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid #30363d;padding:.5rem .75rem;text-align:left}
th{background:#161b22}.ok{color:#3fb950}.bad{color:#f85149}
.meta{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1.5rem}
</style></head><body>
<h1>Central Pet Schedule Review</h1>
<div class="meta">
<p><strong>Rep:</strong> ${escapeHtml(json.rep.name)} (District ${json.rep.district})</p>
<p><strong>Week:</strong> ${escapeHtml(json.week.label)} (${escapeHtml(json.week.start)} – ${escapeHtml(json.week.end)})</p>
<p><strong>Master Route:</strong> ${escapeHtml(json.masterRouteVersion)}</p>
<p><strong>Approved:</strong> ${escapeHtml(json.approvedAt)} by ${escapeHtml(json.approvedBy)}</p>
</div>
<h2>Week grid</h2>
<table><thead><tr><th>Date</th><th>Day</th><th>Store</th>${showAssignee ? '<th>Proposed assignee</th>' : ''}<th>Account</th><th>Action</th><th>Shift</th><th>MR</th></tr></thead><tbody>${rows}</tbody></table>
${json.rep?.isD8Pool ? '<p><em>D8 proposed assignees are planning labels only — no notifications are sent.</em></p>' : ''}
${warnings ? `<h2>Warnings</h2><ul>${warnings}</ul>` : ''}
</body></html>`;
}

function enrichPlacements(placements, validationResults, prodShifts = []) {
  const prodByStoreDate = new Map(
    prodShifts.map((s) => [`${s.storeNum}:${s.scheduledDate}`, s])
  );

  return placements.map((p) => {
    const vr = validationResults.find(
      (r) => r.storeNum === p.storeNum && (r.visitIndex ?? 0) === (p.visitIndex ?? 0)
    );
    const prod = prodByStoreDate.get(`${p.storeNum}:${p.scheduledDate}`);
    let prodDelta = { type: 'create' };
    if (prod) {
      prodDelta = {
        type: prod.scheduledDate === p.scheduledDate ? 'unchanged' : 'move',
        existingVisitId: prod.visitId,
        existingShiftId: prod.shiftId,
      };
    }
    return {
      ...p,
      dayOfWeek: p.dayOfWeek || dateToDayOfWeek(p.scheduledDate),
      masterRoute: vr?.slot
        ? {
            anchorServiceDay: vr.slot.anchorServiceDay,
            allowedDays: vr.slot.allowedDays,
            pickDay: vr.slot.pickDay,
            deliveryDay: vr.slot.deliveryDay,
          }
        : null,
      masterRouteValid: vr?.valid ?? false,
      prodDelta,
    };
  });
}

module.exports = {
  buildHandoffJson,
  buildHandoffMarkdown,
  buildReviewHtml,
  enrichPlacements,
};
