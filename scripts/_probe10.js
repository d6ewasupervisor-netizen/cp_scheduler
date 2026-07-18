(async()=>{
  const { defaultSasFetch } = require('/app/src/lib/live-executor');
  const { loadSasSession } = require('/app/src/lib/sas-session');
  const s = await loadSasSession();
  const headers = { Accept:'application/json', 'X-Requested-With':'XMLHttpRequest', 'Content-Type':'application/json' };
  if (s.token) headers.Authorization = 'Token '+s.token;
  if (s.csrfToken) headers['X-CSRFToken'] = s.csrfToken;
  if (s.cookieHeader) headers.Cookie = s.cookieHeader;
  const url='https://prod.sasretail.com/api/v2/field-app/shifts/44567128/';
  const get = await defaultSasFetch(url, { method:'GET', headers });
  console.log('GET ok=', get.ok, 'status=', get.status, 'fieldCount=', get.body&&typeof get.body==='object'?Object.keys(get.body).length:'n/a');
  if(!get.ok||!get.body){ console.log('GET body:', JSON.stringify(get.body).slice(0,400)); return; }
  const full = get.body;
  const overrides = { actual_start_date:'2026-07-17', actual_start_time:'16:23:22', actual_end_date:'2026-07-17', actual_end_time:'17:36:00', no_show:false, time_change_reason:5, time_change_comment:'James 2026-07-17 T&E', home_to_store:true, store_to_store:true, store_to_home:true, calculate_mileage:true };
  const body = { ...full, ...overrides };
  const patch = await defaultSasFetch(url, { method:'PATCH', headers, body });
  console.log('PATCH status=', patch.status, 'ok=', patch.ok);
  console.log('PATCH response:', JSON.stringify(patch.body).slice(0,1600));
})().catch(e=>console.log('PROBE_ERR', e.message));
