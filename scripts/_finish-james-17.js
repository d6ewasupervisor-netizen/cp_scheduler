// Diagnostic + finish for James 2026-07-17 (visit 27071906). Dumps the full
// category-reset + shift state so we see exactly what blocks completion.
(async()=>{
  const { defaultSasGet } = require('/app/src/lib/prod-transmitter');
  const { loadSasSession } = require('/app/src/lib/sas-session');
  const s = await loadSasSession();
  const token = s.token;
  const V = 27071906, SH = 44567128;

  const crWrap = await defaultSasGet(token, `/field-app/visits/${V}/category-resets/`);
  const resets = (crWrap && crWrap.category_resets) || crWrap || [];
  const R = (Array.isArray(resets)?resets:[])[0];
  console.log('RESET LIST id:', R && R.id, 'keys:', R && Object.keys(R).join(','));

  const detail = await defaultSasGet(token, `/field-app/visits/${V}/category-resets/${R.id}/`);
  console.log('RESET DETAIL keys:', detail && Object.keys(detail).join(','));
  console.log('  category_completion:', detail && detail.category_completion, '| completion_status:', detail && detail.completion_status);
  console.log('  spent_time:', JSON.stringify(detail && detail.spent_time), '| spent_time_reason:', JSON.stringify(detail && detail.spent_time_reason));
  console.log('  team:', JSON.stringify(detail && detail.team).slice(0,300));
  console.log('  new_assignee/assignee:', JSON.stringify(detail && (detail.new_assignee || detail.assignee)));
  console.log('  items:', JSON.stringify(detail && (detail.items || detail.reset_items)).slice(0,400));
  console.log('  before:', !!(detail && detail.before), '| after:', !!(detail && detail.after));

  const shift = await defaultSasGet(token, `/v2/field-app/shifts/${SH}/`);
  console.log('SHIFT employee:', JSON.stringify(shift && shift.employee), '| team:', JSON.stringify(shift && shift.team).slice(0,200));

  const sc = await defaultSasGet(token, `/field-app/visits/${V}/shift-complete/`);
  console.log('shift-complete employees:', JSON.stringify((sc&&sc.employees||[])));
})().catch(e=>console.log('ERR', e.message));
