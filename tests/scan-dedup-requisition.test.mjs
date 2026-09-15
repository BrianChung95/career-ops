// tests/scan-dedup-requisition.test.mjs — company+role dedupe honours
// requisition IDs.
//
// The company+role key collapses same-titled postings so a role re-listed at a
// new URL is not evaluated twice. That is wrong when the employer runs two
// genuinely different requisitions under one title at the same time. Live
// shape: UBC posted "Programmer Analyst I" as JR25919 (Automation Solution
// Delivery) and JR25853 (Facilities). JR25919 was in the tracker with
// "req JR25919" in its notes, and the scan dropped JR25853 as a duplicate on
// the day it closed.
//
// The halves this file gates:
//   - the requisition parse: Workday URL tails and labelled notes agree, and
//     Workday's `-N` repost suffix is the same requisition;
//   - the decision is conservative: any seeded row without a requisition, or a
//     candidate without one, keeps the historical "duplicate" answer;
//   - end to end through the CLI: the labelled tracker row lets JR25853 through
//     once (not again on a second run), and an unlabelled tracker row still
//     suppresses both.
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  ANY_REQUISITION,
  collectSeenCompanyRoles,
  companyRoleDedupKey,
  isDistinctRequisition,
  requisitionIdForDedup,
} from '../scan.mjs';

console.log('\nscan.mjs — requisition-aware company+role dedupe');

const WD = 'https://ubc.wd10.myworkdayjobs.com/ubcstaffjobs/job/UBC-Vancouver-Campus---Vancouver-BC-Canada';
const trackerWith = (notes) => `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-09-14 | UBC | Programmer Analyst I | 4.2/5 | Applied | ✅ | [001](../reports/001-ubc-2026-09-14.md) | ${notes} |
`;

// ── 1. Requisition parse ─────────────────────────────────────────────────────
{
  const cases = [
    [{ url: `${WD}/Programmer-Analyst-I_JR25853` }, '25853', 'Workday URL tail'],
    [{ url: `${WD}/Development-Coordinator--Library_JR25830-1` }, '25830', 'Workday -N repost suffix is the same requisition'],
    [{ text: 'req JR25919; Deadline 2026-09-17' }, '25919', 'labelled tracker note'],
    [{ text: 'JR25919 one-year term' }, '25919', 'bare JR label'],
    [{ url: 'https://job-boards.greenhouse.io/acme/jobs/4244715009' }, null, 'generic board posting id is not a requisition'],
    [{ text: 'remote Canada; base CAD 140K' }, null, 'unlabelled note'],
  ];
  for (const [input, want, label] of cases) {
    const got = requisitionIdForDedup(input);
    if (got === want) pass(`requisitionIdForDedup: ${label}`);
    else fail(`requisitionIdForDedup: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ── 2. Decision is conservative ──────────────────────────────────────────────
{
  const checks = [
    [new Set(['25919']), '25853', true, 'different labelled requisition is distinct'],
    [new Set(['25919']), '25919', false, 'same requisition is a duplicate'],
    [new Set(['25919', ANY_REQUISITION]), '25853', false, 'an unlabelled seed keeps the duplicate'],
    [new Set(['25919']), null, false, 'an unlabelled candidate keeps the duplicate'],
    [undefined, '25853', false, 'no seed data keeps the duplicate'],
  ];
  for (const [seeded, candidate, want, label] of checks) {
    if (isDistinctRequisition(seeded, candidate) === want) pass(`isDistinctRequisition: ${label}`);
    else fail(`isDistinctRequisition: ${label} — expected ${want}`);
  }
}

// ── 3. Seeding reads every source ────────────────────────────────────────────
{
  const requisitionsByBase = new Map();
  collectSeenCompanyRoles({
    applicationsText: trackerWith('req JR25919'),
    pipelineText: `- [x] ${WD}/Programmer-Analyst-I_JR25919 | UBC | Programmer Analyst I | applied\n`,
    scanHistoryText: `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n${WD}/Programmer-Analyst-I_JR25919\t2026-09-14\tUBC\tProgrammer Analyst I\tUBC\tadded\tVancouver\n`,
  }, {}, undefined, { requisitionsByBase });
  const seeded = requisitionsByBase.get(companyRoleDedupKey('UBC', 'Programmer Analyst I'));
  if (seeded && seeded.size === 1 && seeded.has('25919')) {
    pass('collectSeenCompanyRoles: tracker note, pipeline URL and scan-history URL all seed the same requisition');
  } else {
    fail(`collectSeenCompanyRoles seeded [${seeded ? [...seeded].join(', ') : 'nothing'}], want [25919]`);
  }
}

// ── 4. END-TO-END: two scan runs over the two-requisition board ─────────────
function runScanTwice(trackerNotes) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-reqdedup-e2e-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), trackerWith(trackerNotes));
    writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');

    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, `scan_history:
  dedup_include_location: true
title_filter:
  positive:
    - "Programmer Analyst"
tracked_companies:
  - name: UBC
    careers_url: https://ubc.wd10.myworkdayjobs.com/ubcstaffjobs
    parser:
      command: node
      script: tests/fixtures/two-requisition-board.mjs
`);

    const scan = () => execFileSync(NODE, [join(ROOT, 'scan.mjs')], {
      cwd: dir,
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: portals },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entries = () => {
      const p = join(dir, 'data', 'pipeline.md');
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf-8').split('\n').filter(l => /^- \[[ x]\]\s+https?:\/\//.test(l));
    };

    scan();
    const afterFirst = entries();
    scan();
    const afterSecond = entries();
    return { afterFirst, afterSecond };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  try {
    const { afterFirst, afterSecond } = runScanTwice('req JR25919; applied');
    if (afterFirst.length === 1 && afterFirst[0].includes('_JR25853') && afterSecond.length === 1) {
      pass('e2e: labelled tracker row lets the other requisition through once, and not again on run 2');
    } else {
      fail(`e2e labelled: run 1 ${JSON.stringify(afterFirst)}, run 2 has ${afterSecond.length} (want only JR25853, once)`);
    }
  } catch (err) {
    fail(`e2e scan run (labelled tracker) failed: ${err.message}`);
  }
}

{
  try {
    const { afterFirst, afterSecond } = runScanTwice('applied; hybrid unconfirmed');
    if (afterFirst.length === 0 && afterSecond.length === 0) {
      pass('e2e control: an unlabelled tracker row still suppresses every same-titled posting');
    } else {
      fail(`e2e control: ${afterFirst.length} entries after run 1, ${afterSecond.length} after run 2 (want 0 and 0)`);
    }
  } catch (err) {
    fail(`e2e scan run (unlabelled tracker) failed: ${err.message}`);
  }
}
