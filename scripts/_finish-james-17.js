// Dump the full category-reset item values for James 2026-07-17 (visit 27071906).
(async()=>{
  const { defaultSasGet } = require('/app/src/lib/prod-transmitter');
  const { loadSasSession } = require('/app/src/lib/sas-session');
  const s = await loadSasSession();
  const token = s.token;
  const V = 27071906, SH = 44567128;

  const crWrap = await defaultSasGet(token, `/field-app/visits/${V}/category-resets/`);
  const resets = (crWrap && crWrap.category_resets) || crWrap || [];
  const R = (Array.isArray(resets)?resets:[])[0];
  const pick = (o,ks)=>Object.fromEntries(ks.map(k=>[k,o&&o[k]]));
  console.log('RESET completion fields:', JSON.stringify(pick(R,['id','completed','category_completion','state','exception','comment'])));
  console.log('RESET requirements:', JSON.stringify(pick(R,['is_assignee_required','is_before_image_required','is_after_image_required','is_photo_required','is_exception_required','is_comment_required'])));
  console.log('RESET team:', JSON.stringify(R && R.team).slice(0,400));
  console.log('RESET est/act size:', JSON.stringify(pick(R,['est_size_numerator','act_size_numerator','require_footage','repack_count','new_items_stocked'])));

  const shift = await defaultSasGet(token, `/v2/field-app/shifts/${SH}/`);
  console.log('SHIFT employee:', JSON.stringify(shift && shift.employee));
  console.log('SHIFT team:', JSON.stringify(shift && shift.team).slice(0,300));
})().catch(e=>console.log('ERR', e.message, e.stack&&e.stack.slice(0,200)));
