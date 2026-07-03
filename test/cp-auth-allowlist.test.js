'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('cp-auth-allowlist', () => {
  const origAdmin = process.env.CP_SCHEDULER_ADMIN_EMAILS;
  const origRep = process.env.CP_SCHEDULER_REP_EMAILS;

  it('allows corporate, rep-layer, mapped, and admin emails without Postgres', () => {
    process.env.CP_SCHEDULER_ADMIN_EMAILS = 'tgauthier2011@gmail.com';
    process.env.CP_SCHEDULER_REP_EMAILS =
      'd6ewa.supervisor@gmail.com,patricia.marks@youradv.com';
    delete require.cache[require.resolve('../src/lib/cp-auth-allowlist')];
    delete require.cache[require.resolve('../src/lib/cp-roles')];
    const { isCpSchedulerAllowed } = require('../src/lib/cp-auth-allowlist');

    assert.equal(isCpSchedulerAllowed('patricia.marks@youradv.com'), true);
    assert.equal(isCpSchedulerAllowed('d6ewa.supervisor@gmail.com'), true);
    assert.equal(isCpSchedulerAllowed('bcampb9565@sbcglobal.net'), true);
    assert.equal(isCpSchedulerAllowed('tgauthier2011@gmail.com'), true);
    assert.equal(isCpSchedulerAllowed('random@gmail.com'), false);
  });

  it('restores env', () => {
    if (origAdmin === undefined) delete process.env.CP_SCHEDULER_ADMIN_EMAILS;
    else process.env.CP_SCHEDULER_ADMIN_EMAILS = origAdmin;
    if (origRep === undefined) delete process.env.CP_SCHEDULER_REP_EMAILS;
    else process.env.CP_SCHEDULER_REP_EMAILS = origRep;
  });
});
