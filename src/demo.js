import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportAudit } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/formula.json', import.meta.url), 65536);
for (const [scenario, choices] of [
  ['Consistent practice speed', ['m', 's']],
  ['Known unit mismatch', ['m', 'm']],
  ['Unknown source unit blocks the audit', ['m', 'unknown']],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'dimensional-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const value of choices) {
      result = await step(options);
      api.answer(result.answers.find(answer => answer.status === 'pending').questionId, value);
      result = await step(options);
    }
    const exported = result.status === 'complete' ? await exportAudit(directory, input) : null;
    console.log(JSON.stringify({ scenario, status: result.status, audit: result.audit, exported: exported !== null, actionsExecuted: false }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline demo used the pinned SDK with a local mock transport. No live pings, numerical evaluation, conversions or external actions.');
