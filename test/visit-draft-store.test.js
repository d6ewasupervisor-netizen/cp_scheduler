'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../src/lib/visit-draft-store');
const visitFlow = require('../src/lib/visit-flow');

// Isolate all fixture writes under rep keys unlikely to collide with real data,
// and wipe them before/after so the test suite leaves no artifacts behind.
const REP_A = 'test-fixture-rep-a';
const REP_B = 'test-fixture-rep-b';

function cleanup() {
  for (const rep of [REP_A, REP_B]) {
    const dir = path.join(store.ROOT, rep);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Fill every Stage 3 seal requirement for a draft (any order is fine). */
function fillSealRequirements(repKey, date, actualStore, { workLoad = false, writeOrder = false } = {}) {
  store.recordBeforePhoto(repKey, date, actualStore, { photoPath: 'fake/before.jpg' });
  if (workLoad) {
    store.setLoadCheck(repKey, date, actualStore, { status: 'no_escalated' });
  }
  if (writeOrder) {
    for (const item of visitFlow.writeOrderChecklistItems()) {
      store.setChecklistItem(repKey, date, actualStore, item.id, { checked: true });
      if (item.photoRequired) {
        store.recordChecklistPhoto(repKey, date, actualStore, item.id, { photoPath: `fake/cl-${item.id}.jpg` });
      }
    }
  }
  for (const cat of visitFlow.CATEGORY_PHOTO_TARGETS) {
    store.recordCategoryPhoto(repKey, date, actualStore, cat.id, { photoPath: `fake/cat-${cat.id}.jpg` });
  }
  store.setSurveyAnswers(repKey, date, actualStore, {
    q1: 'yes',
    q2: 'Yes',
    q3: 'Fully stocked',
    q5: 'yes',
    q7: 'Yes',
    q9: 'yes',
    q11: 'all good',
    q12: 'yes',
  });
  store.recordAfterPhoto(repKey, date, actualStore, { photoPath: 'fake/after.jpg' });
  store.setTimes(repKey, date, actualStore, { stopActual: `${date}T18:00:00Z` });
  store.setMileage(repKey, date, actualStore, {
    leg: { from: 'home', to: String(actualStore), miles: 1.5, source: 'home-to-store', warning: null },
  });
  store.setShiftLog(repKey, date, actualStore, {
    outcomes: [{ optionId: 'worked_load_wrote_order', kind: 'outcome', label: 'Worked load and wrote order' }],
  });
}

before(cleanup);
after(cleanup);

describe('startVisit / resume', () => {
  it('creates a fresh in-progress draft with the right step sequence', () => {
    const draft = store.startVisit({
      repKey: REP_A,
      weekStart: '2026-07-06',
      shiftId: 'shift-1',
      date: '2026-07-08',
      actualStore: 215,
      scheduledStore: 391,
      writeOrder: true,
      workLoad: true,
      picksDay: 'Tue',
    });
    assert.equal(draft.status, 'in_progress');
    assert.equal(draft.actualStore, 215);
    assert.equal(draft.scheduledStore, 391);
    assert.deepEqual(draft.steps, [
      'before_photos',
      'load_check',
      'write_order_checklist',
      'after_photos',
      'survey',
      'time',
      'shift_log',
      'review',
    ]);
    assert.equal(draft.currentStep, 'before_photos');
    assert.ok(draft.startedAt);
    assert.equal(draft.visitStart.source, 'start_tap');
  });

  it('starting again on the same rep/date/store resumes the existing draft (no reset)', () => {
    store.setChecklistItem(REP_A, '2026-07-08', 215, 'ewc-01', { checked: true });
    const resumed = store.startVisit({
      repKey: REP_A,
      weekStart: '2026-07-06',
      shiftId: 'shift-1',
      date: '2026-07-08',
      actualStore: 215,
      writeOrder: true,
      workLoad: true,
    });
    assert.equal(resumed.checklist['ewc-01'].checked, true);
  });

  it('finished/sealed draft is immutable — mutation throws', () => {
    store.startVisit({
      repKey: REP_A,
      date: '2026-07-09',
      actualStore: 19,
      writeOrder: false,
      workLoad: false,
    });
    fillSealRequirements(REP_A, '2026-07-09', 19);
    store.finishVisit(REP_A, '2026-07-09', 19);
    assert.throws(() => store.setChecklistItem(REP_A, '2026-07-09', 19, 'x', { checked: true }), /sealed/i);
  });

  it('abandonVisit removes in-progress draft and photo dir; refuses sealed', () => {
    store.startVisit({
      repKey: REP_A,
      date: '2026-07-15',
      actualStore: 53,
      writeOrder: true,
      workLoad: false,
    });
    store.recordBeforePhoto(REP_A, '2026-07-15', 53, { photoPath: 'fake/b.jpg' });
    const photoDir = store.photoDirPath(REP_A, '2026-07-15', 53);
    fs.mkdirSync(photoDir, { recursive: true });
    fs.writeFileSync(path.join(photoDir, 'x.jpg'), Buffer.from([1]));

    const result = store.abandonVisit(REP_A, '2026-07-15', 53);
    assert.equal(result.ok, true);
    assert.equal(result.abandonedId, 'test-fixture-rep-a/2026-07-15-53');
    assert.equal(store.getDraft(REP_A, '2026-07-15', 53), null);
    assert.equal(fs.existsSync(store.draftFilePath(REP_A, '2026-07-15', 53)), false);
    assert.equal(fs.existsSync(photoDir), false);

    store.startVisit({
      repKey: REP_A,
      date: '2026-07-15',
      actualStore: 53,
      writeOrder: false,
      workLoad: false,
    });
    fillSealRequirements(REP_A, '2026-07-15', 53);
    store.finishVisit(REP_A, '2026-07-15', 53);
    assert.throws(() => store.abandonVisit(REP_A, '2026-07-15', 53), /sealed/i);
    // cleanup sealed leftover so later suite cases stay isolated
    const sealedFile = store.draftFilePath(REP_A, '2026-07-15', 53);
    if (fs.existsSync(sealedFile)) fs.unlinkSync(sealedFile);
    const sealedPhotos = store.photoDirPath(REP_A, '2026-07-15', 53);
    if (fs.existsSync(sealedPhotos)) fs.rmSync(sealedPhotos, { recursive: true, force: true });
  });
});

describe('autosave after every discrete action + resume mid-branch', () => {
  const DATE = '2026-07-10';
  const S = 111;

  it('persists a photo capture, a checklist tick, a survey answer, and a step change independently', () => {
    store.startVisit({ repKey: REP_A, date: DATE, actualStore: S, writeOrder: true, workLoad: false });

    store.recordBeforePhoto(REP_A, DATE, S, { photoPath: 'fake/before-1.jpg' });
    let d = store.getDraft(REP_A, DATE, S);
    assert.equal(d.beforePhotos.length, 1);
    assert.equal(d.beforePhotos[0].store, S); // tagged with decoded store
    assert.equal(d.beforePhotos[0].category, 'before');
    assert.equal(d.beforePhotos[0].seq, 1);

    store.setChecklistItem(REP_A, DATE, S, 'ewc-01', { checked: true });
    d = store.getDraft(REP_A, DATE, S);
    assert.equal(d.checklist['ewc-01'].checked, true);

    store.setSurveyAnswers(REP_A, DATE, S, { q1: 'yes', q3: 'Fully stocked' });
    d = store.getDraft(REP_A, DATE, S);
    assert.equal(d.survey.q3, 'Fully stocked');

    store.goToStep(REP_A, DATE, S, 'after_photos');
    d = store.getDraft(REP_A, DATE, S);
    assert.equal(d.currentStep, 'after_photos');

    // Simulate "kill and reopen the app" — a totally fresh read from disk
    // must reflect every one of the above, resuming exactly mid-branch.
    const reopened = store.getDraft(REP_A, DATE, S);
    assert.equal(reopened.beforePhotos.length, 1);
    assert.equal(reopened.checklist['ewc-01'].checked, true);
    assert.equal(reopened.survey.q1, 'yes');
    assert.equal(reopened.currentStep, 'after_photos');
  });

  it('resumes correctly after simulating an interrupt inside the load-check branch', () => {
    const date = '2026-07-11';
    store.startVisit({ repKey: REP_A, date, actualStore: 682, writeOrder: false, workLoad: true });
    store.goToStep(REP_A, date, 682, 'load_check');
    store.setLoadCheck(REP_A, date, 682, { status: 'no_found_later' });

    // "Interrupt" — nothing more happens until the app is reopened.
    const resumed = store.getDraft(REP_A, date, 682);
    assert.equal(resumed.currentStep, 'load_check');
    assert.equal(resumed.loadCheck.status, 'no_found_later');

    // Rep escalates on the next attempt.
    store.setLoadCheck(REP_A, date, 682, { status: 'no_escalated' });
    assert.equal(store.getDraft(REP_A, date, 682).loadCheck.status, 'no_escalated');
  });

  it('resumes correctly after simulating an interrupt inside the time step', () => {
    const date = '2026-07-12';
    store.startVisit({ repKey: REP_A, date, actualStore: 28, writeOrder: false, workLoad: false });
    store.goToStep(REP_A, date, 28, 'time');
    store.setTimes(REP_A, date, 28, { stopActual: '2026-07-12T15:00:00Z', isLastStopOfDay: true });

    const resumed = store.getDraft(REP_A, date, 28);
    assert.equal(resumed.currentStep, 'time');
    assert.equal(resumed.visitStop.actual, '2026-07-12T15:00:00Z');
    assert.equal(resumed.isLastStopOfDay, true);
  });
});

describe('survey Q1/Q12 auto-fill is persisted as soon as photos land', () => {
  it('sets q1=yes on the draft the moment a before photo is recorded (no manual survey step needed)', () => {
    const date = '2026-07-17';
    store.startVisit({ repKey: REP_A, date, actualStore: 658, writeOrder: false, workLoad: false });
    let d = store.getDraft(REP_A, date, 658);
    assert.equal(d.survey.q1, undefined);

    d = store.recordBeforePhoto(REP_A, date, 658, { photoPath: 'fake/before.jpg' });
    assert.equal(d.survey.q1, 'yes');
    assert.equal(d.survey.q12, undefined);

    d = store.recordAfterPhoto(REP_A, date, 658, { photoPath: 'fake/after.jpg' });
    assert.equal(d.survey.q12, 'yes');
  });

  it('does not clobber a manually entered q1 answer', () => {
    const date = '2026-07-18';
    store.startVisit({ repKey: REP_A, date, actualStore: 459, writeOrder: false, workLoad: false });
    store.setSurveyAnswers(REP_A, date, 459, { q1: 'No' });
    const d = store.recordBeforePhoto(REP_A, date, 459, { photoPath: 'fake/before.jpg' });
    assert.equal(d.survey.q1, 'No');
  });
});

describe('photo tagging uses the DECODED store even when scheduled differs', () => {
  it('category photo tag store matches actualStore, not scheduledStore', () => {
    const date = '2026-07-13';
    store.startVisit({
      repKey: REP_A,
      date,
      actualStore: 215,
      scheduledStore: 391,
      writeOrder: false,
      workLoad: false,
    });
    store.recordCategoryPhoto(REP_A, date, 215, 'endcaps', { photoPath: 'fake/endcap.jpg' });
    const d = store.getDraft(REP_A, date, 215);
    const photo = d.categoryPhotos.endcaps[0];
    assert.equal(photo.store, 215);
    assert.notEqual(photo.store, 391);
    assert.equal(photo.category, 'endcaps');
    assert.equal(photo.date, date);
  });
});

describe('category photos assigned from after library', () => {
  it('assignCategoryFromAfter reuses the after path and removeAfter drops the assignment', () => {
    const date = '2026-07-25';
    const S = 658;
    store.startVisit({ repKey: REP_A, date, actualStore: S, writeOrder: false, workLoad: false });
    store.recordAfterPhoto(REP_A, date, S, { photoPath: 'fake/after-1.jpg' });
    store.recordAfterPhoto(REP_A, date, S, { photoPath: 'fake/after-2.jpg' });
    let d = store.assignCategoryFromAfter(REP_A, date, S, 'endcaps', { afterSeq: 2 });
    assert.equal(d.categoryPhotos.endcaps.length, 1);
    assert.equal(d.categoryPhotos.endcaps[0].path, 'fake/after-2.jpg');
    assert.equal(d.categoryPhotos.endcaps[0].fromAfterSeq, 2);
    // Idempotent re-assign
    d = store.assignCategoryFromAfter(REP_A, date, S, 'endcaps', { afterSeq: 2 });
    assert.equal(d.categoryPhotos.endcaps.length, 1);
    // Removing the after clears the category assignment
    d = store.removeAfterPhoto(REP_A, date, S, { seq: 2 });
    assert.equal(d.afterPhotos.length, 1);
    assert.equal((d.categoryPhotos.endcaps || []).length, 0);
  });
});

describe('mileage: previousCompletedStoreForDay (mid-day leg selection)', () => {
  const date = '2026-07-14';

  it('returns null when nothing completed yet today', () => {
    store.startVisit({ repKey: REP_A, date, actualStore: 19, writeOrder: false, workLoad: false });
    const prev = store.previousCompletedStoreForDay(REP_A, date, { excludeActualStore: 19 });
    assert.equal(prev, null);
  });

  it('finds the most recently completed store, excluding the current one', () => {
    store.startVisit({ repKey: REP_A, date, actualStore: 19, writeOrder: false, workLoad: false });
    store.setTimes(REP_A, date, 19, { stopActual: '2026-07-14T14:00:00Z' });

    store.startVisit({ repKey: REP_A, date, actualStore: 23, writeOrder: false, workLoad: false });
    store.setTimes(REP_A, date, 23, { stopActual: '2026-07-14T16:00:00Z' });

    store.startVisit({ repKey: REP_A, date, actualStore: 28, writeOrder: false, workLoad: false });

    const prev = store.previousCompletedStoreForDay(REP_A, date, { excludeActualStore: 28 });
    assert.equal(prev, 23); // later stopActual wins over 19
  });
});

describe('free-nav: out-of-order completion, edit-after-later, interrupt, seal gate', () => {
  it('out-of-order completion (survey before photos, time first) seals fine', () => {
    const date = '2026-07-20';
    const S = 23;
    store.startVisit({ repKey: REP_A, date, actualStore: S, writeOrder: false, workLoad: true });

    // Time first
    store.goToStep(REP_A, date, S, 'time');
    store.setTimes(REP_A, date, S, { stopActual: `${date}T17:00:00Z` });
    store.setMileage(REP_A, date, S, {
      leg: { from: 'home', to: String(S), miles: 2, source: 'home-to-store', warning: null },
    });

    // Survey before any photos
    store.goToStep(REP_A, date, S, 'survey');
    store.setSurveyAnswers(REP_A, date, S, {
      q2: 'Yes',
      q3: 'Fully stocked',
      q5: 'yes',
      q7: 'Yes',
      q9: 'yes',
      q11: 'survey first',
    });

    // Load escalation (valid complete outcome) before before-photos
    store.goToStep(REP_A, date, S, 'load_check');
    store.setLoadCheck(REP_A, date, S, { status: 'no_escalated' });

    // Then photos + categories (still free order)
    store.goToStep(REP_A, date, S, 'review'); // Review anytime, even incomplete
    store.recordBeforePhoto(REP_A, date, S, { photoPath: 'fake/before-ooo.jpg' });
    for (const cat of visitFlow.CATEGORY_PHOTO_TARGETS) {
      store.recordCategoryPhoto(REP_A, date, S, cat.id, { photoPath: `fake/${cat.id}.jpg` });
    }
    store.recordAfterPhoto(REP_A, date, S, { photoPath: 'fake/after-ooo.jpg' });
    store.setShiftLog(REP_A, date, S, {
      outcomes: [{ optionId: 'cleaned_up_section', kind: 'outcome', label: 'Cleaned up the section' }],
    });

    const d = store.getDraft(REP_A, date, S);
    assert.equal(d.survey.q1, 'yes'); // auto-filled from before photo
    assert.equal(d.survey.q12, 'yes');
    assert.equal(store.canSeal(d), true);
    const sealed = store.finishVisit(REP_A, date, S);
    assert.equal(sealed.status, 'ready_for_prod');
  });

  it('edit-after-later-work: change Q3 after Q4; flip Q5 No→Yes→No keeps Q6 text; photo add/remove flips Q1', () => {
    const date = '2026-07-21';
    const S = 28;
    store.startVisit({ repKey: REP_A, date, actualStore: S, writeOrder: false, workLoad: false });

    // Later section first
    store.goToStep(REP_A, date, S, 'survey');
    store.setSurveyAnswers(REP_A, date, S, {
      q3: 'Partially stocked with holes / OOS',
      q4: 'holes throughout aisle',
      q5: 'no',
      q6: 'clip strips not in store',
    });
    let d = store.getDraft(REP_A, date, S);
    assert.equal(d.survey.q4, 'holes throughout aisle');
    assert.equal(d.survey.q6, 'clip strips not in store');

    // Change parent Q3 → Q4 hidden but text retained
    store.setSurveyAnswers(REP_A, date, S, { q3: 'Fully stocked' });
    d = store.getDraft(REP_A, date, S);
    assert.equal(d.survey.q3, 'Fully stocked');
    assert.equal(d.survey.q4, 'holes throughout aisle'); // retained, not deleted
    assert.equal(visitFlow.surveyVisibility(d.survey).find((v) => v.id === 'q4').visible, false);

    // Flip Q5 No → Yes → No; Q6 text retained throughout
    store.setSurveyAnswers(REP_A, date, S, { q5: 'yes' });
    d = store.getDraft(REP_A, date, S);
    assert.equal(d.survey.q6, 'clip strips not in store');
    assert.equal(visitFlow.surveyVisibility(d.survey).find((v) => v.id === 'q6').visible, false);
    store.setSurveyAnswers(REP_A, date, S, { q5: 'no' });
    d = store.getDraft(REP_A, date, S);
    assert.equal(d.survey.q6, 'clip strips not in store');
    assert.equal(visitFlow.surveyVisibility(d.survey).find((v) => v.id === 'q6').visible, true);

    // Q1 reactive to before photos add/remove at any point
    assert.equal(d.survey.q1, undefined);
    store.recordBeforePhoto(REP_A, date, S, { photoPath: 'fake/b1.jpg' });
    d = store.getDraft(REP_A, date, S);
    assert.equal(d.survey.q1, 'yes');
    store.removeBeforePhoto(REP_A, date, S);
    d = store.getDraft(REP_A, date, S);
    assert.equal(d.survey.q1, undefined);
    store.recordBeforePhoto(REP_A, date, S, { photoPath: 'fake/b2.jpg' });
    assert.equal(store.getDraft(REP_A, date, S).survey.q1, 'yes');
  });

  it('interrupt/resume mid out-of-order edit loses nothing (per-action autosave)', () => {
    const date = '2026-07-22';
    const S = 31;
    store.startVisit({ repKey: REP_A, date, actualStore: S, writeOrder: true, workLoad: false });

    // Jump to survey, answer one question, jump to checklist, tick one item, capture a category photo
    store.goToStep(REP_A, date, S, 'survey');
    store.setSurveyAnswers(REP_A, date, S, { q2: 'Service day only (no new order)' });
    store.goToStep(REP_A, date, S, 'write_order_checklist');
    store.setChecklistItem(REP_A, date, S, 'ewc-01', { checked: true });
    store.goToStep(REP_A, date, S, 'after_photos');
    store.recordAfterPhoto(REP_A, date, S, { photoPath: 'fake/after-1.jpg' });
    store.assignCategoryFromAfter(REP_A, date, S, 'endcaps', { afterSeq: 1 });
    store.goToStep(REP_A, date, S, 'time');
    store.setTimes(REP_A, date, S, { stopActual: `${date}T14:30:00Z` });

    // Kill app / reopen — fresh disk read
    const resumed = store.getDraft(REP_A, date, S);
    assert.equal(resumed.currentStep, 'time');
    assert.equal(resumed.survey.q2, 'Service day only (no new order)');
    assert.equal(resumed.checklist['ewc-01'].checked, true);
    assert.equal(resumed.categoryPhotos.endcaps.length, 1);
    assert.equal(resumed.visitStop.actual, `${date}T14:30:00Z`);
  });

  it('seal blocked with correct reason list; deep-link fields land on section+anchor', () => {
    const date = '2026-07-23';
    const S = 658;
    store.startVisit({ repKey: REP_A, date, actualStore: S, writeOrder: false, workLoad: false });
    store.goToStep(REP_A, date, S, 'review');

    let blocked;
    try {
      store.finishVisit(REP_A, date, S);
    } catch (err) {
      blocked = err;
    }
    assert.ok(blocked);
    assert.equal(blocked.code, 'SEAL_BLOCKED');
    assert.ok(Array.isArray(blocked.unmet) && blocked.unmet.length > 0);

    const sections = new Set(blocked.unmet.map((u) => u.section));
    assert.ok(sections.has('before_photos'));
    assert.ok(sections.has('survey'));
    assert.ok(sections.has('after_photos'));
    assert.ok(sections.has('time'));
    // Missing fixture coverage surfaces on after_photos (AI sort / coaching), not a separate step
    assert.ok(blocked.unmet.some((u) => u.section === 'after_photos' && /end caps/i.test(u.message)));

    for (const u of blocked.unmet) {
      assert.ok(u.section && u.anchor && u.message, 'each unmet row needs section+anchor+message for Review deep links');
    }

    // Still in progress — not sealed
    assert.equal(store.getDraft(REP_A, date, S).status, 'in_progress');

    // After filling, seal succeeds
    fillSealRequirements(REP_A, date, S);
    const sealed = store.finishVisit(REP_A, date, S);
    assert.equal(sealed.status, 'ready_for_prod');
  });

  it('goToStep allows any section in any order with no completion gate', () => {
    const date = '2026-07-24';
    const S = 111;
    store.startVisit({ repKey: REP_A, date, actualStore: S, writeOrder: true, workLoad: true });
    const order = ['review', 'time', 'survey', 'load_check', 'before_photos', 'write_order_checklist', 'after_photos'];
    for (const step of order) {
      const d = store.goToStep(REP_A, date, S, step);
      assert.equal(d.currentStep, step);
    }
  });
});

describe('scope enforcement — reps never see each other\'s drafts', () => {
  it('listDraftsForRep only returns that rep\'s own drafts', () => {
    store.startVisit({ repKey: REP_B, date: '2026-07-15', actualStore: 53, writeOrder: false, workLoad: false });
    const aDrafts = store.listDraftsForRep(REP_A);
    const bDrafts = store.listDraftsForRep(REP_B);
    assert.ok(aDrafts.every((d) => d.repKey === REP_A));
    assert.ok(bDrafts.every((d) => d.repKey === REP_B));
    assert.ok(!aDrafts.some((d) => d.actualStore === 53));
  });

  it('getDraft for rep A cannot be retrieved by asking for rep B\'s key', () => {
    store.startVisit({ repKey: REP_A, date: '2026-07-16', actualStore: 391, writeOrder: false, workLoad: false });
    const asB = store.getDraft(REP_B, '2026-07-16', 391);
    assert.equal(asB, null);
    const asA = store.getDraft(REP_A, '2026-07-16', 391);
    assert.ok(asA);
  });

  it('listAllDrafts (admin-only) sees drafts across every rep', () => {
    const all = store.listAllDrafts();
    const reps = new Set(all.map((d) => d.repKey));
    assert.ok(reps.has(REP_A));
    assert.ok(reps.has(REP_B));
  });

  it('summarize includes step label and photo counts for live monitor', () => {
    const date = '2026-07-18';
    const S = 215;
    store.startVisit({
      repKey: REP_A,
      date,
      actualStore: S,
      scheduledStore: 391,
      writeOrder: true,
      workLoad: false,
      shiftId: 'sum-1',
      weekStart: '2026-07-13',
    });
    store.recordBeforePhoto(REP_A, date, S, { photoPath: 'fake/before.jpg' });
    const draft = store.getDraft(REP_A, date, S);
    const sum = store.summarize(draft);
    assert.equal(sum.beforePhotoCount, 1);
    assert.equal(sum.afterPhotoCount, 0);
    assert.equal(sum.currentStepLabel, 'Before Photos');
    assert.ok(sum.updatedAt);
    assert.equal(sum.surveyAnswerCount >= 0, true);
  });
});
