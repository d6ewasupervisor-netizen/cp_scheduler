'use strict';

/**
 * Live execution artifacts under live/{runId}/.
 * Same secret-pattern guard as dryrun-store — never write a live token to disk.
 */

const fs = require('fs');
const path = require('path');
const { assertNoSecrets } = require('./dryrun-store');

let ROOT = path.join(__dirname, '../../live');

function setRoot(dir) {
  ROOT = dir;
}

function getRoot() {
  return ROOT;
}

function safeSeg(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function runDir(runId) {
  return path.join(ROOT, safeSeg(runId));
}

function stateFileName(visitFile) {
  return `state-${safeSeg(visitFile)}`;
}

function logFileName(visitFile) {
  return `execution-log-${safeSeg(visitFile)}`;
}

function redactForLog(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (/authorization/i.test(k) && typeof v === 'string') {
        node[k] = v.replace(/Token\s+\S+/i, 'Token {{REDACTED}}');
      } else if (typeof v === 'string' && /Token\s+[0-9a-f]{20,}/i.test(v)) {
        node[k] = v.replace(/Token\s+[0-9a-f]{20,}/gi, 'Token {{REDACTED}}');
      } else if (/^pin$/i.test(k) && v != null && v !== '') {
        node[k] = '{{PIN_REDACTED}}';
      } else if (k === 'base64' && typeof v === 'string' && v.length > 80) {
        node[k] = `[base64 ${v.length} chars redacted from log]`;
      } else {
        walk(v);
      }
    }
  }
  walk(clone);
  return clone;
}

function writeExecutionLog(runId, visitFile, log) {
  const safe = redactForLog(log);
  assertNoSecrets(safe);
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, logFileName(visitFile));
  fs.writeFileSync(file, JSON.stringify(safe, null, 2));
  return file;
}

function readExecutionLog(runId, visitFile) {
  const file = path.join(runDir(runId), logFileName(visitFile));
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeExecutorState(runId, visitFile, state) {
  const safe = redactForLog(state);
  assertNoSecrets(safe);
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, stateFileName(visitFile));
  fs.writeFileSync(file, JSON.stringify(safe, null, 2));
  return file;
}

function readExecutorState(runId, visitFile) {
  const file = path.join(runDir(runId), stateFileName(visitFile));
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  get ROOT() {
    return ROOT;
  },
  set ROOT(dir) {
    ROOT = dir;
  },
  setRoot,
  getRoot,
  runDir,
  stateFileName,
  logFileName,
  redactForLog,
  writeExecutionLog,
  readExecutionLog,
  writeExecutorState,
  readExecutorState,
  assertNoSecrets,
};
