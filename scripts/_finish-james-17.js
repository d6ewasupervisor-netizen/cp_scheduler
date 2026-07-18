// Complete James 2026-07-17 (visit 27071906): mark category reset(s) done with the
// correct field (category_completion), then PUT shift-complete. Verifies status.
(async()=>{
  const { defaultSasFetch } = require('/app/src/lib/live-executor');
  const { defaultSasGet } = require('/app/src/lib/prod-transmitter');
  const { loadSasSession } = require('/app/src/lib/sas-session');
  const s = await loadSasSession();
  const token = s.token;
  const V = 27071906;
  const headers = { Accept:'application/json', 'X-Requested-With':'XMLHttpRequest', 'Content-Type':'application/json' };
  if (s.token) headers.Authorization = 'Token '+s.token;
  if (s.csrfToken) headers['X-CSRFToken'] = s.csrfToken;
  if (s.cookieHeader) headers.Cookie = s.cookieHeader;

  const before = await defaultSasGet(token, `/field-app/visits/${V}/shift-complete/`);
  console.log('BEFORE current_status:', before && before.current_status);

  const crWrap = await defaultSasGet(token, `/field-app/visits/${V}/category-resets/`);
  const resets = (crWrap && crWrap.category_resets) || crWrap || [];
  console.log('category resets:', JSON.stringify((Array.isArray(resets)?resets:[]).map(r=>({id:r.id, name:r.name, category_completion:r.category_completion, completion_status:r.completion_status, spent_time:r.spent_time}))));

  for (const r of (Array.isArray(resets)?resets:[])) {
    if (r.category_completion === true) { console.log('reset', r.id, 'already complete'); continue; }
    const url = `https://prod.sasretail.com/api/v1/field-app/visits/${V}/category-resets/${r.id}/`;
    const res = await defaultSasFetch(url, { method:'PATCH', headers, body:{ category_completion:true, id:r.id, comment:'', exception:null } });
    console.log('category_completion PATCH reset', r.id, '->', res.status, JSON.stringify(res.body).slice(0,200));
  }

  const scUrl = `https://prod.sasretail.com/api/v1/field-app/visits/${V}/shift-complete/`;
  const put = await defaultSasFetch(scUrl, { method:'PUT', headers, body:{ allowed_overlap:false, allowed_missing_ques:false, allowed_truncation:false, team_lead_feedback:null, end_location:[-1,-1], validate_geo:true } });
  console.log('PUT shift-complete ->', put.status, 'ok', put.ok, '|', JSON.stringify(put.body).slice(0,300));
  const patch = await defaultSasFetch(scUrl, { method:'PATCH', headers, body:{ team_lead_feedback:null } });
  console.log('final PATCH ->', patch.status);

  const after = await defaultSasGet(token, `/field-app/visits/${V}/shift-complete/`);
  console.log('AFTER current_status:', after && after.current_status);
})().catch(e=>console.log('ERR', e.message));
