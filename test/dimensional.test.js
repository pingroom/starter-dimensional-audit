import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportAudit } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, auditFormula, UNITS, LIMITS, itemsFor, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/formula.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-dimensional-audit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later unit judgments; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'm'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a unit judgment', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'm'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'm'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.audit, null);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('original asker, lifetime and intent remain bound across reads and across unit judgments', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'm'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).audit, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'm');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'm'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'm'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing reviewer before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'm');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'm'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).audit, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});


const variable = id => ({ type: 'variable', id });
const binary = (type, left, right) => ({ type, left, right });
const power = (base, exponent) => ({ type: 'power', base, exponent });
const constant = value => ({ type: 'constant', value });
function formula(expression, assignments = { x: 'm', y: 's' }, expectedUnit = null) {
  return { auditId: 'dimension-test', title: 'Practice formula', context: 'Source owner supplies actual units.',
    variables: Object.entries(assignments).map(([id, unit]) => ({ id, meaning: `Quantity ${id}.`, source: `Practice source for ${id}.`, candidates: [unit, unit === 'one' ? 'm' : 'one'] })), expression, expectedUnit };
}
const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
const rational = (n, d = 1n) => { const common = gcd(n, d); return [n / common, d / common]; };
const signature = { one: [1n, 1n], m: [3n, 1n], s: [5n, 1n], kg: [2n, 1n], m_per_s: [3n, 5n], m_per_s2: [3n, 25n], newton: [6n, 25n] };
function oracle(node, choices) {
  if (node.type === 'variable') return signature[choices[node.id]];
  if (node.type === 'constant') return [1n, 1n];
  if (node.type === 'power') {
    const base = oracle(node.base, choices); if (base === null) return null;
    const [n, d] = base, p = BigInt(Math.abs(node.exponent));
    return rational((node.exponent < 0 ? d : n) ** p, (node.exponent < 0 ? n : d) ** p);
  }
  const left = oracle(node.left, choices), right = oracle(node.right, choices); if (left === null || right === null) return null;
  const [a, b] = left, [c, d] = right;
  if (['add', 'subtract'].includes(node.type)) return a * d === b * c ? left : null;
  return node.type === 'multiply' ? rational(a * c, b * d) : rational(a * d, b * c);
}
function exponents(signature) {
  if (signature === null) return null;
  let [n, d] = signature;
  return [2n, 3n, 5n].map(prime => {
    let exponent = 0;
    while (n % prime === 0n) { n /= prime; exponent++; }
    while (d % prime === 0n) { d /= prime; exponent--; }
    return exponent;
  });
}

test('all 11172 small binary AST/unit cases match an independent rational-prime oracle', () => {
  let count = 0;
  const types = ['add', 'subtract', 'multiply', 'divide'], units = Object.keys(signature);
  for (const x of units) for (const y of units) for (const outer of types) {
    const choices = { x, y }, expression = binary(outer, variable('x'), variable('y'));
    const result = auditFormula(formula(expression, choices), choices), expected = exponents(oracle(expression, choices));
    assert.deepEqual(result.rootDimension, expected); assert.equal(result.consistent, expected !== null); count++;
    for (const z of units) for (const inner of types) for (const side of ['left', 'right']) {
      const all = { x, y, z }, child = binary(inner, variable('x'), variable('y'));
      const nested = side === 'left' ? binary(outer, child, variable('z')) : binary(outer, variable('z'), child);
      const audited = auditFormula(formula(nested, all), all), dimension = exponents(oracle(nested, all));
      assert.deepEqual(audited.rootDimension, dimension); assert.equal(audited.consistent, dimension !== null); count++;
    }
  }
  assert.equal(count, 11172);
});

test('all 49 unit/power cases, multiplication cancellation and dimensionless constants follow exact exponent laws', () => {
  for (const x of Object.keys(signature)) for (let exponent = -3; exponent <= 3; exponent++) {
    const expression = power(variable('x'), exponent);
    assert.deepEqual(auditFormula(formula(expression, { x }), { x }).rootDimension, exponents(oracle(expression, { x })));
    const cancelled = binary('divide', variable('x'), variable('x'));
    assert.deepEqual(auditFormula(formula(cancelled, { x }), { x }).rootDimension, [0, 0, 0]);
    const zero = binary('divide', variable('x'), constant(0));
    const result = auditFormula(formula(zero, { x }), { x });
    assert.deepEqual(result.rootDimension, UNITS[x].dimension); assert.equal(result.numericalValidityChecked, false);
  }
  const dimensionless = binary('multiply', constant(-2.5), variable('x'));
  assert.deepEqual(auditFormula(formula(dimensionless, { x: 'newton' }), { x: 'newton' }).rootDimension, [1, 1, -2]);
});

test('mismatched operands have exact paths and evidence; all ancestors including power zero remain blocked', () => {
  const bad = binary('add', variable('x'), variable('y'));
  const expression = binary('multiply', power(bad, 0), binary('subtract', variable('y'), variable('x')));
  const result = auditFormula(formula(expression, { x: 'm', y: 's' }, 'one'), { x: 'm', y: 's' });
  assert.equal(result.consistent, false); assert.equal(result.rootDimension, null); assert.equal(result.expected.compatible, null);
  assert.deepEqual(result.errors.map(error => error.path), ['/expression/left/base', '/expression/right']);
  assert.deepEqual(result.errors[0].operands, [
    { path: '/expression/left/base/left', status: 'known', dimension: [0, 1, 0] },
    { path: '/expression/left/base/right', status: 'known', dimension: [0, 0, 1] },
  ]);
  assert.deepEqual(result.blockedPaths, ['/expression/left', '/expression']);
  assert.ok(result.nodes.filter(node => node.status !== 'known').every(node => node.dimension === null));
});

test('known expected-output mismatch is complete and exportable with full source and attribution', async t => {
  const s = await setup(t), done = await decide(s, ['m', 'm']);
  assert.equal(done.status, 'complete'); assert.equal(done.audit.consistent, false); assert.deepEqual(done.audit.rootDimension, [0, 0, 0]);
  assert.deepEqual(done.audit.errors, [{ path: '/expression', kind: 'expected_dimension_mismatch', actual: [0, 0, 0], expected: [0, 1, -1], expectedUnit: 'm_per_s' }]);
  const before = s.api.calls.length, exported = await exportAudit(s.directory, s.options.input), artifact = await readJson(exported.path);
  assert.equal(exported.consistent, false); assert.equal(exported.auditHash, done.audit.auditHash); assert.deepEqual(artifact.audit, done.audit);
  assert.deepEqual(artifact.source, validateInput(example)); assert.equal(artifact.sourceHash, hash(validateInput(example))); assert.equal(artifact.configHash, hash(CONFIG));
  assert.ok(artifact.answers.every(row => row.responderId === CONFIG.participant.id && row.askerId === ASKER && row.questionId && row.answeredAt));
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600); assert.equal(s.api.calls.length, before);
  assert.equal(artifact.formulaExecuted, false); assert.equal(artifact.conversionsPerformed, false);
});

test('known compatible formula exports; incompatible addition is also a complete negative audit', async t => {
  const s = await setup(t), done = await decide(s, ['m', 's']); assert.equal(done.audit.consistent, true);
  assert.deepEqual(done.audit.rootDimension, [0, 1, -1]); assert.equal(done.audit.expected.compatible, true); await exportAudit(s.directory, s.options.input);
  const input = simple(); input.expression.type = 'add';
  const bad = await setup(t, input), negative = await decide(bad, ['m', 's']);
  assert.equal(negative.status, 'complete'); assert.equal(negative.audit.consistent, false); assert.equal(negative.audit.rootDimension, null);
  assert.equal(negative.audit.errors[0].kind, 'operand_dimension_mismatch'); await exportAudit(bad.directory, input);
});

test('Unknown, missing and failed answers block the whole audit and export without guesses or resends', async t => {
  const s = await setup(t); await assert.rejects(exportAudit(s.directory, s.options.input), /No dimensional-audit session/);
  await s.run(); await assert.rejects(exportAudit(s.directory, s.options.input), /known unit/);
  s.api.answer(id(1), 'unknown'); await s.run(); await s.run(); s.api.answer(id(2), 's');
  const done = await s.run(); assert.equal(done.status, 'incomplete'); assert.equal(done.audit, null); assert.deepEqual(done.unknownVariableIds, ['distance']);
  await assert.rejects(exportAudit(s.directory, s.options.input), /known unit/); await s.run(); assert.equal(sends(s.api), 2);
  await assert.rejects(readFile(join(s.directory, 'dimensional-audit.json')), { code: 'ENOENT' });
  for (const terminal of ['expired', 'cancelled']) {
    const other = await setup(t); await other.run(); if (terminal === 'expired') other.clock.value = '2026-01-01T09:16:00.000Z';
    other.api.terminal(id(1), terminal); await other.run(); await other.run(); other.api.answer(id(2), 's');
    assert.equal((await other.run()).audit, null); await assert.rejects(exportAudit(other.directory, other.options.input));
  }
  for (const choices of [{ distance: 'm' }, { distance: 'm', duration: 'unknown' }, { distance: 'kg', duration: 's' }, { distance: 'm', duration: 's', extra: 'm' }]) assert.throws(() => auditFormula(example, choices), /known unit/);
});

test('canonical variable/candidate ordering preserves state; changed source, AST, expectation or participant cannot reuse it', async t => {
  const s = await setup(t); await s.run(); const reordered = simple(); reordered.variables.reverse(); reordered.variables.forEach(v => v.candidates.reverse());
  assert.equal(hash(validateInput(reordered)), hash(validateInput(example))); assert.equal((await s.run({ input: reordered })).status, 'pending');
  for (const mutate of [input => { input.variables[0].source += ' Changed'; }, input => { input.expression.type = 'multiply'; }, input => { input.expectedUnit = 'm'; }]) {
    const input = simple(); mutate(input); const before = s.api.calls.length; await assert.rejects(s.run({ input }), /changed formula/); assert.equal(s.api.calls.length, before);
  }
  await assert.rejects(s.run({ config: { participant: { ...CONFIG.participant, id: OTHER } } }), /another connection/);
});

test('AST/schema boundaries reject injected code, unknown references, extra keys, unused variables, invalid candidates and Unicode', async t => {
  const mutations = [input => { input.expression = 'process.exit()'; }, input => { input.extra = true; }, input => { input.expression.extra = true; },
    input => { input.expression.left.id = 'missing'; }, input => { input.expression = variable('distance'); }, input => { input.expression.type = 'eval'; },
    input => { input.expression.left = constant('1'); }, input => { input.expression.left = constant(Infinity); }, input => { input.expression.left = constant(1000001); },
    input => { input.expression.left = power(variable('distance'), 0.5); }, input => { input.expression.left = power(variable('distance'), 4); },
    input => { input.variables[0].id = 'constructor'; }, input => { input.variables[0].extra = 1; }, input => { input.variables[0].id += '\n'; },
    input => { input.variables[0].candidates = ['m', 'm']; }, input => { input.variables[0].candidates = ['m']; }, input => { input.variables[0].candidates = ['cm', 'm']; },
    input => { input.variables[0].meaning += '\u2028'; }, input => { input.variables[0].source = '\ud800'; }, input => { input.context += '\u200b'; },
    input => { input.expectedUnit = 'kelvin'; }, input => { input.variables.push(structuredClone(input.variables[0])); }, input => { input.variables = []; },
  ];
  for (const mutate of mutations) { const input = simple(); mutate(input); assert.throws(() => validateInput(input)); const s = await setup(t); await assert.rejects(s.run({ input })); assert.equal(s.api.calls.length, 0); }
  for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
    assert.equal(isId(CONFIG.participant.id + suffix), false); assert.equal(ROOM.test(ROOM_CODE + suffix), false);
    assert.throws(() => validateConnection({ token: 'token' + suffix, room: ROOM_CODE }));
    assert.throws(() => validateConfig({ participant: { ...CONFIG.participant, id: CONFIG.participant.id + suffix } }));
  }
});

test('node, depth and conservative exponent bounds are enforced before requests', () => {
  let tree = variable('x'); for (let depth = 0; depth < 5; depth++) tree = binary('multiply', tree, structuredClone(tree));
  const assignments = { x: 'newton' }, exact = formula(tree, assignments);
  assert.deepEqual(auditFormula(exact, assignments).rootDimension, [32, 32, -64]);
  assert.throws(() => validateInput(formula(power(tree, 1), assignments)), /63 AST nodes/);
  let deep = variable('x'); for (let depth = 0; depth < 7; depth++) deep = power(deep, 1);
  assert.doesNotThrow(() => validateInput(formula(deep, { x: 'm' })));
  assert.throws(() => validateInput(formula(power(deep, 1), { x: 'm' })), /depth 8/);
  let exponential = variable('x'); for (let i = 0; i < 4; i++) exponential = power(exponential, 3);
  assert.throws(() => validateInput(formula(exponential, { x: 'm' })), /exponent bound/);
  const nine = {}; for (let i = 0; i < 9; i++) nine['v' + i] = 'm';
  assert.throws(() => validateInput(formula(variable('v0'), nine)), /1–8 variables/);
});

test('all eight maximum Unicode prompts include complete context/source and fit the published SDK limit', async t => {
  const assignments = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['v' + String(i).repeat(15), 'm']));
  const ids = Object.keys(assignments); let expression = variable(ids[0]);
  for (const id of ids.slice(1)) expression = binary('add', expression, variable(id));
  const input = formula(expression, assignments); input.title = '🧪'.repeat(20); input.context = '🧪'.repeat(35);
  for (const v of input.variables) { v.meaning = '🧪'.repeat(35); v.source = '🧪'.repeat(55); v.candidates = ['m', 'm_per_s2', 'newton']; }
  const s = await setup(t, input), result = await decide(s, Array(8).fill('m'));
  assert.equal(result.status, 'complete'); assert.equal(sends(s.api), 8);
  for (const call of s.api.calls.filter(call => call.method === 'POST')) {
    assert.ok(call.body.prompt.length <= 500); assert.ok(call.body.prompt.includes(input.context));
    const item = input.variables.find(v => v.id === call.body.data.item_id);
    assert.ok(call.body.prompt.includes(item.id)); assert.ok(call.body.prompt.includes(item.meaning)); assert.ok(call.body.prompt.includes(item.source));
    assert.equal(call.body.options.length, 4); assert.equal(call.body.options.at(-1).value, 'unknown');
  }
});

test('locked export is rejected and corrupt evidence never replaces a prior private artifact', async t => {
  const s = await setup(t); await decide(s, ['m', 's']); const exported = await exportAudit(s.directory, s.options.input), before = await readFile(exported.path, 'utf8');
  const release = await acquireLock(s.directory); await assert.rejects(exportAudit(s.directory, s.options.input), /lock exists/); await release();
  const state = await s.saved(); state.attempts[0].observation.answer.responderId = OTHER; await atomicJson(s.directory, 'state.json', state);
  await assert.rejects(exportAudit(s.directory, s.options.input)); assert.equal(await readFile(exported.path, 'utf8'), before);
});
