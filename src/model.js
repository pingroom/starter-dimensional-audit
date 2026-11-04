import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__'].includes(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unit = (label, dimension) => Object.freeze({ label, dimension: Object.freeze(dimension) });
export const UNITS = Object.freeze({
  one: unit('1 (dimensionless)', [0, 0, 0]), m: unit('m (metre)', [0, 1, 0]), s: unit('s (second)', [0, 0, 1]),
  kg: unit('kg (kilogram)', [1, 0, 0]), m_per_s: unit('m/s (speed)', [0, 1, -1]),
  m_per_s2: unit('m/s^2 (acceleration)', [0, 1, -2]), newton: unit('N (newton)', [1, 1, -2]),
});
export const LIMITS = Object.freeze({ variables: 8, nodes: 63, depth: 8, power: 3, dimensionExponent: 64 });
const isUnit = value => typeof value === 'string' && Object.hasOwn(UNITS, value);
const equal = (a, b) => a.every((value, i) => value === b[i]);

export function validateInput(input) {
  if (!keys(input, ['auditId', 'title', 'context', 'variables', 'expression', 'expectedUnit']) || !word(input.auditId)
    || !line(input.title, 40) || !line(input.context, 70) || !(input.expectedUnit === null || isUnit(input.expectedUnit))
    || !Array.isArray(input.variables) || input.variables.length < 1 || input.variables.length > LIMITS.variables) throw new Error('Supply a formula ID, bounded title/context, 1–8 variables, typed expression and expectedUnit (catalog ID or null).');
  const ids = new Set();
  for (const variable of input.variables) {
    if (!keys(variable, ['id', 'meaning', 'source', 'candidates']) || !safeId(variable.id) || ids.has(variable.id)
      || !line(variable.meaning, 70) || !line(variable.source, 110) || !Array.isArray(variable.candidates)
      || variable.candidates.length < 2 || variable.candidates.length > 3 || !variable.candidates.every(isUnit)
      || new Set(variable.candidates).size !== variable.candidates.length) throw new Error('Variables need unique safe IDs, meaning up to 70, source up to 110 UTF-16 units and 2–3 distinct catalog unit IDs.');
    ids.add(variable.id);
  }
  const used = new Set(); let count = 0;
  function visit(node, depth) {
    if (++count > LIMITS.nodes || depth > LIMITS.depth || !record(node)) throw new Error('Formula exceeds 63 AST nodes or depth 8, or includes an invalid node.');
    let bound;
    if (node.type === 'variable') {
      if (!keys(node, ['type', 'id']) || !ids.has(node.id)) throw new Error('Variable nodes must reference a declared variable ID.');
      used.add(node.id);
      const variable = input.variables.find(v => v.id === node.id);
      bound = [0, 1, 2].map(i => Math.max(...variable.candidates.map(id => Math.abs(UNITS[id].dimension[i]))));
    } else if (node.type === 'constant') {
      if (!keys(node, ['type', 'value']) || !Number.isFinite(node.value) || Math.abs(node.value) > 1e6) throw new Error('Constants must be finite dimensionless numbers with magnitude at most 1000000.');
      bound = [0, 0, 0];
    } else if (node.type === 'power') {
      if (!keys(node, ['type', 'base', 'exponent']) || !Number.isInteger(node.exponent) || Math.abs(node.exponent) > LIMITS.power) throw new Error('Power nodes need an integer exponent from -3 to 3.');
      bound = visit(node.base, depth + 1).map(value => value * Math.abs(node.exponent));
    } else if (['add', 'subtract', 'multiply', 'divide'].includes(node.type)) {
      if (!keys(node, ['type', 'left', 'right'])) throw new Error('Binary nodes need exactly type, left and right.');
      const left = visit(node.left, depth + 1), right = visit(node.right, depth + 1);
      bound = left.map((value, i) => ['add', 'subtract'].includes(node.type) ? Math.max(value, right[i]) : value + right[i]);
    } else throw new Error('Unsupported AST node type.');
    if (bound.some(value => value > LIMITS.dimensionExponent)) throw new Error('Formula can exceed the conservative dimension exponent bound of 64.');
    return bound;
  }
  visit(input.expression, 1);
  if (used.size !== ids.size) throw new Error('Every declared variable must appear in the expression.');
  const result = structuredClone(input);
  result.variables.sort((a, b) => compare(a.id, b.id));
  for (const variable of result.variables) variable.candidates.sort(compare);
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact source-owner UUID and label.');
  return structuredClone(config);
}
export function itemsFor(rawInput) { return validateInput(rawInput).variables; }
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput), item = input.variables.find(item => item.id === itemId); validateConfig(config);
  if (!item || !isId(attemptId)) throw new Error('Invalid variable or attempt.');
  const prompt = `${input.title}\nContext: ${input.context}\nVariable [${item.id}]: ${item.meaning}\nSource: ${item.source}\nWhich unit does this variable actually use in this source? Choose Unknown if unclear or none fits. No conversion.`;
  if (prompt.length > 500) throw new Error('Unit prompt exceeds 500 characters.');
  const key = `dimension-${attemptId}`;
  return { prompt, context: `To ${config.participant.id}`,
    options: [...item.candidates.map(value => ({ value, label: UNITS[value].label, style: 'default' })), { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), catalog_hash: hash(UNITS), item_id: item.id, attempt_id: attemptId }, idempotencyKey: key };
}

/** An audit inspects dimensions only; numeric values are never evaluated. */
export function auditFormula(rawInput, choices) {
  const input = validateInput(rawInput);
  if (!keys(choices, input.variables.map(v => v.id)) || input.variables.some(v => !v.candidates.includes(choices[v.id]))) throw new Error('Every variable requires one declared known unit before dimensional analysis.');
  const nodes = [], errors = [];
  const evidence = (node, path) => {
    const entry = { path, type: node.type, status: 'known', dimension: null };
    if (node.type === 'variable') { entry.variableId = node.id; entry.unitId = choices[node.id]; entry.dimension = [...UNITS[entry.unitId].dimension]; }
    else if (node.type === 'constant') { entry.value = node.value; entry.dimension = [0, 0, 0]; }
    else {
      const operands = node.type === 'power' ? [evidence(node.base, `${path}/base`)]
        : [evidence(node.left, `${path}/left`), evidence(node.right, `${path}/right`)];
      entry.operands = operands.map(child => ({ path: child.path, status: child.status, dimension: child.dimension }));
      if (node.type === 'power') entry.exponent = node.exponent;
      if (operands.some(child => child.status !== 'known')) entry.status = 'blocked';
      else if (['add', 'subtract'].includes(node.type) && !equal(operands[0].dimension, operands[1].dimension)) {
        entry.status = 'mismatch';
        errors.push({ path, kind: 'operand_dimension_mismatch', operator: node.type, operands: structuredClone(entry.operands) });
      } else {
        const [left, right] = operands.map(child => child.dimension);
        entry.dimension = node.type === 'power' ? left.map(value => value * node.exponent)
          : node.type === 'multiply' ? left.map((value, i) => value + right[i])
          : node.type === 'divide' ? left.map((value, i) => value - right[i]) : [...left];
        entry.dimension = entry.dimension.map(value => value === 0 ? 0 : value);
        if (entry.dimension.some(value => !Number.isInteger(value) || Math.abs(value) > LIMITS.dimensionExponent)) throw new Error('Internal dimension bound violated.');
      }
    }
    nodes.push(entry); return entry;
  };
  const root = evidence(input.expression, '/expression');
  const expected = input.expectedUnit === null ? null : { unitId: input.expectedUnit, dimension: [...UNITS[input.expectedUnit].dimension], compatible: root.dimension === null ? null : equal(root.dimension, UNITS[input.expectedUnit].dimension) };
  if (expected?.compatible === false) errors.push({ path: '/expression', kind: 'expected_dimension_mismatch', actual: [...root.dimension], expected: [...expected.dimension], expectedUnit: input.expectedUnit });
  const result = { dimensionOrder: ['mass', 'length', 'time'], assignments: input.variables.map(v => ({ variableId: v.id, unitId: choices[v.id], dimension: [...UNITS[choices[v.id]].dimension] })),
    rootDimension: root.dimension, expected, consistent: errors.length === 0, nodes, errors,
    blockedPaths: nodes.filter(node => node.status === 'blocked').map(node => node.path), numericalValidityChecked: false, limits: { ...LIMITS } };
  return { ...result, auditHash: hash(result) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed formula manifest. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved unit judgment or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last judgment may have an active Question.');
  }
  return state;
}


export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = itemsFor(input).map(item => {
    const attempt = state.attempts.find(attempt => attempt.itemId === item.id), answer = attempt?.observation?.answer;
    return { variableId: item.id, meaning: item.meaning, source: item.source, candidates: item.candidates,
      status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked', choice: answer?.value ?? null, label: answer?.label ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null, responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const active = answers.find(item => ['create_unknown', 'pending'].includes(item.status));
  const complete = answers.every(item => item.status === 'answered' && item.candidates.includes(item.choice));
  const audit = complete ? auditFormula(input, Object.fromEntries(answers.map(item => [item.variableId, item.choice]))) : null;
  const status = active?.status ?? (answers.some(item => item.status === 'unasked') ? 'ready' : complete ? 'complete' : 'incomplete');
  return { auditId: input.auditId, sourceHash: hash(input), source: input, participant: state.config.participant, room: state.room,
    configHash: hash(state.config), unitCatalog: structuredClone(UNITS), catalogHash: hash(UNITS), answers, status, audit, unknownVariableIds: answers.filter(item => item.choice === 'unknown').map(item => item.variableId),
    formulaExecuted: false, conversionsPerformed: false, actionsExecuted: false };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved unit judgment evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered unit judgments must not contain unit judgment evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
