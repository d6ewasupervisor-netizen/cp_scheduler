// Finish James 2026-07-17 (visit 27071906): assign the category reset to the
// employee (is_assignee_required + empty team was the blocker), set spent_time,
// mark category_completion, then complete the visit. Verifies each step.
(async()=>{
  const { defaultSasFetch } = require('/app/src/lib/live-executor');
  const { defaultSasGet } = require('/app/src/lib/prod-transmitter');
  const { loadSasSession } = require('/app/src/lib/sas-session');
  const s = await loadSasSession();
  const token = s.token;
  const V = 27071906, SH = 44567128, EMP = 394407, RID = 41531947;
  const headers = { Accept:'application/json', 'X-Requested-With':'XMLHttpRequest', 'Content-Type':'application/json' };
  if (s.token) headers.Authorization = 'Token '+s.token;
  if (s.csrfToken) headers['X-CSRFToken'] = s.csrfToken;
  if (s.cookieHeader) headers.Cookie = s.cookieHeader;
  const rUrl = `https://prod.sasretail.com/api/v1/field-app/visits/${V}/category-resets/${RID}/`;
  const scUrl = `https://prod.sasretail.com/api/v1/field-app/visits/${V}/shift-complete/`;

  const P = async (url, body, label) => {
    const r = await defaultSasFetch(url, { method:'PATCH', headers, body });
    console.log(label, '->', r.status, r.ok?'ok':('FAIL '+JSON.stringify(r.body).slice(0,200)));
    return r;
  };

  await P(rUrl, { id: RID, new_assignee: { visit_id: String(V), employee_id: EMP } }, 'new_assignee');
  await P(rUrl, { id: RID, shift_id: SH, spent_time: '1h 13m', spent_time_reason: { id: 3, text: 'Other – supervisor was contacted' } }, 'spent_time');
  await P(rUrl, { category_completion: true, id: RID, comment: '', exception: null }, 'category_completion');

  const crWrap = await defaultSasGet(token, `/field-app/visits/${V}/category-resets/`);
  const R = ((crWrap && crWrap.category_resets) || crWrap || [])[0];
  console.log('reset completed:', R && R.completed, '| team:', JSON.stringify(R && R.team).slice(0,150));

  const put = await defaultSasFetch(scUrl, { method:'PUT', headers, body:{ allowed_overlap:true, allowed_missing_ques:true, allowed_truncation:true, team_lead_feedback:null, end_location:[-1,-1], validate_geo:true } });
  console.log('PUT shift-complete ->', put.status, put.ok?'ok':('FAIL '+JSON.stringify(put.body).slice(0,300)));
  await defaultSasFetch(scUrl, { method:'PATCH', headers, body:{ team_lead_feedback:null } });

  const after = await defaultSasGet(token, `/field-app/visits/${V}/shift-complete/`);
  console.log('AFTER current_status:', after && after.current_status);
})().catch(e=>console.log('ERR', e.message));
