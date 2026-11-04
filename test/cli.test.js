import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = String.raw`
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const store = process.env.PROBE_STORE;
const questions = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
const save = () => writeFileSync(store, JSON.stringify(questions));
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Unexpected network operation');
  const url = new URL(raw), path = url.pathname;
  if (url.origin !== 'https://api.pingroom.io') throw new Error('Unexpected mock origin');
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({method:init.method,path}) + '\n');
  const participant = '11111111-1111-4111-8111-111111111111';
  if (init.method === 'GET' && path === '/api/agent/rooms') return Response.json([
    {invite_code:'DEMO12345678',type:'standard',is_public:false,members:[{user_id:participant}]}
  ]);
  if (init.method === 'POST' && path === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    const question = {id:'01990000-0000-7000-8000-' + String(questions.length+1).padStart(12,'0'),
      kind:'question',is_handoff:false,prompt:body.prompt,context:body.context,
      options:body.options.map(({value,label})=>({value,label,primary:false,destructive:false})),
      text_input:null,responder_scope:'direct',target_user_id:participant,resolution_policy:'first',
      state:'pending',results:null,answer:null,expires_at:new Date(Date.parse(now)+900000).toISOString(),
      resolved_at:null,correlation_id:body.correlation_id,reply_to:null,data:body.data,created_at:now,
      room_code:'DEMO12345678',room:{code:'DEMO12345678'},asker:{type:'agent',id:'33333333-3333-4333-8333-333333333333'}};
    questions.push(question); save();
    if(process.env.PROBE_LOST === 'yes') throw new Error('Lost response after POST');
    return Response.json(question,{status:201});
  }
  if (init.method === 'GET' && path === '/api/agent/questions') return Response.json({questions});
  const q = questions.find(q=>path === '/api/agent/questions/' + q.id);
  if (init.method === 'GET' && q) {
    const value = process.env.PROBE_ANSWER;
    if (value && q.state === 'pending') {
      q.state='answered';q.resolved_at=new Date().toISOString();
      q.answer={value,label:q.options.find(o=>o.value===value)?.label??'Unsupported',text:null,responder:{id:process.env.PROBE_BAD_ATTR==='yes'?'22222222-2222-4222-8222-222222222222':participant},answered_at:q.resolved_at};save();
    }
    if(process.env.PROBE_CANCEL==='yes'){q.state='cancelled';q.resolved_at=new Date().toISOString();q.answer=null;save();}
    return Response.json(q);
  }
  throw new Error('Unexpected mock request');
};
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'dimensional-cli-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await cp(join(source,'src'),join(directory,'src'),{recursive:true});
  await cp(join(source,'package.json'),join(directory,'package.json'));
  await cp(join(source,'config.example.json'),join(directory,'config.json'));
  const input=JSON.parse(await readFile(join(source,'examples/formula.json'),'utf8'));
  await writeFile(join(directory,'formula.json'),JSON.stringify(input));
  await symlink(join(source,'node_modules'),join(directory,'node_modules'));
  await writeFile(join(directory,'preload.mjs'),preload);
  return directory;
}
function cli(directory,command='run',{answer='',lost=false,offline=false,argument,envOverride={}}={}) {
  const env={...process.env,PINGROOM_TOKEN:'offline-fixture-token',PINGROOM_ROOM:'DEMO12345678',
    PROBE_STORE:join(directory,'questions.json'),PROBE_LOG:join(directory,'requests.jsonl'),
    PROBE_ANSWER:answer,PROBE_LOST:lost?'yes':'no',PROBE_OFFLINE:offline?'yes':'no'};
  Object.assign(env,envOverride);
  for(const key of Object.keys(env))if(env[key]===undefined)delete env[key];
  delete env.NODE_OPTIONS;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',join(directory,'preload.mjs'),join(directory,'src/cli.js'),command,...(argument?[argument]:[])],{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),8000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,json:stdout.trim().startsWith('{')?JSON.parse(stdout):null});});
  });
}
const requests=async directory=>(await readFile(join(directory,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const posts=async directory=>(await requests(directory)).filter(c=>c.method==='POST').length;

async function expect(directory,command,options,code,status) {
  const result=await cli(directory,command,options);
  assert.equal(result.code,code,result.stderr||result.stdout);assert.equal(result.json.status,status);return result.json;
}



async function complete(directory, values = ['m', 's']) {
  let result;
  for (let i = 0; i < values.length; i++) {
    await expect(directory, 'run', {}, 3, 'pending');
    const last = i === values.length - 1, status = !last ? 'ready' : values.includes('unknown') ? 'incomplete' : 'complete';
    result = await expect(directory, 'run', { answer: values[i] }, last ? status === 'complete' ? 0 : 2 : 3, status);
  }
  return result;
}

test('CLI collects actual units and exports a complete audit offline without changing the formula', async t => {
  const directory = await fixture(t), original = await readFile(join(directory, 'formula.json'), 'utf8');
  const preview = await cli(directory, 'preview', { offline: true }); assert.equal(preview.code, 0, preview.stderr); assert.equal(preview.json.variables.length, 2);
  const done = await complete(directory); assert.deepEqual(done.audit.rootDimension, [0, 1, -1]); assert.equal(done.audit.consistent, true); assert.equal(await posts(directory), 2);
  await expect(directory, 'run', { offline: true }, 0, 'complete');
  const saved = await expect(directory, 'report', { offline: true }, 0, 'complete');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.dimensional-audit/report.json'), 'utf8')), saved);
  const exported = await expect(directory, 'export', { offline: true, envOverride: { PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined } }, 0, 'complete');
  assert.equal(exported.sourceHash, done.sourceHash); assert.equal(exported.auditHash, done.audit.auditHash);
  const artifact = JSON.parse(await readFile(exported.path, 'utf8')); assert.deepEqual(artifact.source, done.source); assert.deepEqual(artifact.answers, done.answers); assert.deepEqual(artifact.audit, done.audit);
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600); assert.equal(await readFile(join(directory, 'formula.json'), 'utf8'), original);
  assert.equal(artifact.formulaExecuted, false); assert.equal(artifact.actionsExecuted, false); assert.equal(artifact.conversionsPerformed, false);
});

test('CLI refuses incomplete/Unknown export but exports a fully known negative audit', async t => {
  const directory = await fixture(t); assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
  const result = await complete(directory, ['m', 'unknown']); assert.equal(result.audit, null);
  assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
  await assert.rejects(readFile(join(directory, '.dimensional-audit/dimensional-audit.json')), { code: 'ENOENT' });
  await expect(directory, 'run', { offline: true }, 2, 'incomplete'); assert.equal(await posts(directory), 2);
  const other = await fixture(t), finished = await complete(other, ['m', 'm']);
  assert.equal(finished.status, 'complete'); assert.equal(finished.audit.consistent, false);
  const exported = await expect(other, 'export', { offline: true }, 0, 'complete'); assert.equal(exported.consistent, false);
});

test('CLI recovers one original uncertain question without duplicate sends', async t => {
  const directory = await fixture(t);
  await expect(directory, 'run', { lost: true }, 4, 'create_unknown'); await expect(directory, 'run', { offline: true }, 4, 'create_unknown');
  const found = await expect(directory, 'find', {}, 4, 'create_unknown'); assert.equal(found.candidates.length, 1);
  const qid = found.candidates[0].id, ready = await expect(directory, 'recover', { argument: qid, answer: 'm' }, 3, 'ready');
  assert.equal(ready.answers[0].questionId, qid); assert.equal(ready.answers[0].choice, 'm'); assert.equal(await posts(directory), 1);
});

test('CLI rejects unsupported, misattributed and cancelled evidence without replacing it', async t => {
  for (const options of [{ answer: 'unsupported' }, { answer: 'm', envOverride: { PROBE_BAD_ATTR: 'yes' } }, { envOverride: { PROBE_CANCEL: 'yes' } }]) {
    const directory = await fixture(t); await expect(directory, 'run', {}, 3, 'pending');
    const result = await expect(directory, 'run', options, 2, 'ready'); assert.equal(result.audit, null);
    assert.ok(['invalid_answer', 'cancelled'].includes(result.observedStatus)); assert.equal(await posts(directory), 1);
    assert.equal((await cli(directory, 'export', { offline: true })).code, 1);
  }
});

test('CLI rejects partial environment pairs and accepts a complete dotenv setup', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, '.env'), 'PINGROOM_TOKEN=dotenv-fixture\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = await cli(directory, 'run', { envOverride: { PINGROOM_TOKEN: 'external-fixture', PINGROOM_ROOM: undefined } });
  assert.equal(partial.code, 1); await assert.rejects(readFile(join(directory, 'requests.jsonl')), { code: 'ENOENT' });
  await expect(directory, 'run', { envOverride: { PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined } }, 3, 'pending');
});

test('CLI rejects changed source and arbitrary path/command arguments before another request', async t => {
  const directory = await fixture(t); await expect(directory, 'run', {}, 3, 'pending'); const before = await posts(directory);
  const input = JSON.parse(await readFile(join(directory, 'formula.json'), 'utf8')); input.variables[0].source += ' Changed';
  await writeFile(join(directory, 'formula.json'), JSON.stringify(input)); assert.equal((await cli(directory, 'run', { offline: true })).code, 1);
  for (const command of ['run', 'preview', 'export']) assert.equal((await cli(directory, command, { argument: '../elsewhere.json', offline: true })).code, 1);
  assert.equal((await cli(directory, 'evaluate', { offline: true })).code, 1); assert.equal(await posts(directory), before);
});
