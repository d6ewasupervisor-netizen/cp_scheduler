'use strict';

function normalizeStoreNumber(value) {
  if (value == null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? String(n) : digits.replace(/^0+/, '') || '0';
}

function getVisitStoreNumber(visit) {
  if (!visit) return null;
  const raw =
    visit.store?.store?.number ??
    visit.store?.number ??
    visit.store_name?.number ??
    visit.store_number ??
    null;
  return normalizeStoreNumber(raw);
}

function storesMatch(a, b) {
  const left = normalizeStoreNumber(a);
  const right = normalizeStoreNumber(b);
  if (left == null || right == null) return false;
  return left === right;
}

function filterVisitsByStore(visits, requestedStore) {
  if (requestedStore == null || requestedStore === '') {
    return Array.isArray(visits) ? visits.slice() : [];
  }
  return (visits || []).filter((visit) => storesMatch(getVisitStoreNumber(visit), requestedStore));
}

module.exports = {
  normalizeStoreNumber,
  getVisitStoreNumber,
  storesMatch,
  filterVisitsByStore,
};
