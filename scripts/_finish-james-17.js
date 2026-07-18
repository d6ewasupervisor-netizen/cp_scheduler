// Directly send the two remaining completion calls for James 2026-07-17 (visit 27071906):
// PUT shift-complete (completion body) + final PATCH { team_lead_feedback }. Verifies status.
(async()=>{
  const { defaultSasFetch } = require('/app/src/lib/live-executor');
  const { defaultSasGet } = require('/app/src/lib/prod-transmitter');
  const { loadSasSession } = require('/app/src/lib/sas-session');
  const s = await loadSasSession();
  const token = s.token;
  const V = 27071906;
  const before = await defaultSasGet(token, `/field-app/visits/${V}/shift-complete/`);
  console.log('BEFORE current_status:', before && before.current_status);
  console.log('BEFORE emp times:', JSON.stringify((before&&before.employees||[]).map(e=>({start:e.actual_start_time,end:e.actual_end_time}))));
  if (String(before && before.current_status).toLowerCase() === 'completed') { console.log('ALREADY COMPLETED — nothing to do'); return; }
  const headers = { Accept:'application/json', 'X-Requested-With':'XMLHttpRequest', 'Content-Type':'application/json' };
  if (s.token) headers.Authorization = 'Token '+s.token;
  if (s.csrfToken) headers['X-CSRFToken'] = s.csrfToken;
  if (s.cookieHeader) headers.Cookie = s.cookieHeader;
  const url = `https://prod.sasretail.com/api/v1/field-app/visits/${V}/shift-complete/`;
  const put = await defaultSasFetch(url, { method:'PUT', headers, body:{ allowed_overlap:false, allowed_missing_ques:false, allowed_truncation:false, team_lead_feedback:null, end_location:[-1,-1], validate_geo:true } });
  console.log('PUT status', put.status, 'ok', put.ok, '|', JSON.stringify(put.body).slice(0,300));
  const patch = await defaultSasFetch(url, { method:'PATCH', headers, body:{ team_lead_feedback:null } });
  console.log('PATCH status', patch.status, 'ok', patch.ok, '|', JSON.stringify(patch.body).slice(0,200));
  const after = await defaultSasGet(token, `/field-app/visits/${V}/shift-complete/`);
  console.log('AFTER current_status:', after && after.current_status);
})().catch(e=>console.log('ERR', e.message));
