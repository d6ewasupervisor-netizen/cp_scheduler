'use strict';

const fs = require('fs');
const path = require('path');

const ADDR_FILE = path.join(__dirname, '../../data/d8-store-addresses.json');

function loadStoreAddresses() {
  if (!fs.existsSync(ADDR_FILE)) return { stores: {} };
  return JSON.parse(fs.readFileSync(ADDR_FILE, 'utf8'));
}

function getStoreAddress(storeNum) {
  const data = loadStoreAddresses();
  const row = data.stores?.[String(storeNum)];
  if (!row) return null;
  return {
    storeNum: Number(storeNum),
    name: row.name,
    address: row.address,
    district: row.district || null,
  };
}

module.exports = { loadStoreAddresses, getStoreAddress };
