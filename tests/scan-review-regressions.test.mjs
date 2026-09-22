import assert from 'node:assert/strict';
import { pass } from './helpers.mjs';
import { parseAppliedDate } from '../followup-cadence.mjs';
import { requisitionIdsForDedup as ids, isDistinctRequisition, collectSeenCompanyRoles,
  companyRoleDedupKey as key, matchesSeenCompanyRole } from '../scan.mjs';

for (const label of ['R_#1311', 'r_#1311', 'req #1311']) {
  assert.equal(parseAppliedDate(`${label} Applied 2026-09-01`), '2026-09-01');
}
assert.equal(parseAppliedDate('Sibling #1311 Applied 2026-09-01'), null);
pass('review: R_ requisition hashes preserve applied dates; row references do not');

const lever = 'https://jobs.lever.co/acme/a1';
for (const [a, b] of [['ABC123-1', 'XYZ123-1'], ['ABC123-1', 'ABC1231']]) {
  assert.equal(isDistinctRequisition(new Set(ids({url: lever, text: `req ${a}`})),
    ids({url: lever, text: `req ${b}`})), true);
}
assert.deepEqual(ids({url: lever, text: 'req abc123-1'}), ['ABC123-1']);
assert.deepEqual(ids({text: 'JR25919'}), ['JR25919']);
assert.deepEqual(ids({text: 'JR-10423'}), ['JR-10423']);
assert.deepEqual(ids({text: 'R_1488728'}), ['R_1488728']);
pass('review: prefixes and punctuation distinguish IDs without breaking bare JR/R_ tokens');

for (const text of ['JR 25919', 'JR:25919', 'jr: #25919', 'JR #25919']) {
  assert.deepEqual(ids({text}), ['JR25919']);
}
for (const text of ['R_ 1488728', 'R_:1488728', 'r_#1488728']) {
  assert.deepEqual(ids({text}), ['R_1488728']);
}
assert.deepEqual(ids({text: 'JR-25919'}), ['JR-25919']);
assert.deepEqual(ids({text: 'JR_25919'}), ['JR_25919']);
assert.equal(isDistinctRequisition(new Set(ids({url: lever, text: 'JR-25919'})),
  ids({url: lever, text: 'JR25919'})), true);
pass('review: spaced/colon JR and R_ labels retain their prefix; literal punctuation stays distinct');

for (const text of ['Req #25919', 'req 25919', 'req 25919-1']) {
  assert.deepEqual(ids({text}), []);
  assert.equal(isDistinctRequisition(new Set(['JR25919']), ids({text})), false);
  const requisitions = new Map();
  collectSeenCompanyRoles({applicationsText:
    `| Company | Role | Notes |\n|---|---|---|\n| Acme | Engineer | ${text} |\n`},
  {}, undefined, {requisitionsByBase: requisitions});
  assert.equal(isDistinctRequisition(requisitions.get(key('Acme', 'Engineer')), ['JR25919']), false);
}
assert.deepEqual(ids({url: 'https://acme.wd1.myworkdayjobs.com/jobs/job/Engineer_25919'}), ['25919']);
pass('review: numeric-only notes cannot prove distinctness in either direction; URL IDs remain usable');

const workday = 'https://acme.wd1.myworkdayjobs.com/careers/job/London/Engineer';
assert.deepEqual(ids({url: workday, text: 'req JR25919-1'}), ['JR25919']);
assert.equal(isDistinctRequisition(new Set(['JR25919-1']),
  ids({url: workday, text: 'req JR25919-1'})), true);
assert.deepEqual(ids({text: 'req JR25919-1'}), ['JR25919-1', 'JR25919']);
pass('review: known Workday URLs without URL IDs use only the stripped text ID');

const history = `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation
${workday}_JR100\t2026-09-22\tAcme\tEngineer\tAcme\tadded\tLondon
${workday.replace('London', 'New-York')}_JR200\t2026-09-22\tAcme\tEngineer\tAcme\tadded\tNew York
`;
for (const includeLocation of [true, false]) {
  const requisitions = new Map(), locatedRequisitions = new Map();
  const seen = collectSeenCompanyRoles({scanHistoryText: history}, {}, undefined, {
    includeLocation, requisitionsByBase: requisitions, locatedRequisitionsByBase: locatedRequisitions,
  });
  const baseKey = key('Acme', 'Engineer');
  const matches = (location, candidate) => matchesSeenCompanyRole({
    key: key('Acme', 'Engineer', undefined, includeLocation ? location : undefined),
    baseKey, seen, requisitions, locatedRequisitions,
  }, candidate);
  assert.equal(matches('London', ['JR200']), !includeLocation);
  assert.equal(matches('London', ['JR100']), true);
  assert.equal(matches(undefined, ['JR200']), true);
  assert.equal(matches(undefined, ['JR300']), false);
  if (includeLocation) {
    assert.equal(requisitions.has(baseKey), false);
    assert.equal(matches('Paris', []), false);
    requisitions.get(key('Acme', 'Engineer', undefined, 'New York')).add('*');
    locatedRequisitions.get(baseKey).add('*');
    assert.equal(matches('London', ['JR200']), false);
    assert.equal(matches(undefined, ['JR300']), true);
    seen.add(baseKey);
    requisitions.set(baseKey, new Set(['JR200']));
    assert.equal(matches('London', ['JR200']), true);
    requisitions.set(baseKey, new Set(['*']));
    assert.equal(matches('Paris', ['JR300']), true);
  }
}
pass('review: location matching uses only overlapping requisitions and preserves both wildcard directions');
