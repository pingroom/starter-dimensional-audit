# PingRoom dimensional audit starter

Ask a source owner to identify each variable's unit, then check a formula's dimensions in code. PingRoom collects one choice per variable; the starter exports an attributed audit showing compatible dimensions or the exact expression paths that fail.

The sample is a fictional classroom worksheet: distance divided by duration should have the dimension of speed. The starter never calculates numeric results, converts units or executes an external action.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or later.

```sh
npm ci
npm test
npm run demo
```

The demo uses the real pinned `@pingroom/sdk@0.7.1` with a local mock transport and no credentials. It covers a compatible formula, a known mismatch, and Unknown blocking the audit. CI runs tests and demo on Node 22 and 24. Dependencies and Actions are pinned; `.npmrc` sets a 14-day minimum release age.

## Describe the source and formula

```sh
cp examples/formula.json formula.json
cp config.example.json config.json
npm run preview
```

Edit `formula.json` before collection. It contains `auditId`, `title`, `context`, `variables`, `expression`, and `expectedUnit`. Each variable has an `id`, `meaning`, a `source` excerpt or description, and two or three distinct catalog IDs in `candidates`. Supply enough source detail to identify the unit. Unknown is available when none fits or the source is unclear.

The catalog is fixed in `src/model.js`. Dimension vectors use **[mass, length, time]**:

| Candidate ID | Unit | Dimension |
| --- | --- | --- |
| `one` | dimensionless 1 | `[0, 0, 0]` |
| `m` | metre | `[0, 1, 0]` |
| `s` | second | `[0, 0, 1]` |
| `kg` | kilogram | `[1, 0, 0]` |
| `m_per_s` | metre per second | `[0, 1, -1]` |
| `m_per_s2` | metre per second squared | `[0, 1, -2]` |
| `newton` | newton | `[1, 1, -2]` |

Only these coherent SI units are supported. There are no prefixes, scale conversions, temperature offsets or additional base dimensions. See [NIST SP 330, sections 2.3.3–2.3.4](https://www.nist.gov/pml/special-publication-330/sp-330-section-2) for dimensional exponents and coherent derived units.

The expression is a typed JSON tree. For example:

```json
{
  "type": "divide",
  "left": { "type": "variable", "id": "distance" },
  "right": { "type": "variable", "id": "duration" }
}
```

Supported nodes are:

- `{"type":"variable","id":"distance"}`: reference a declared variable.
- `{"type":"constant","value":2}`: a finite dimensionless number, magnitude at most 1,000,000.
- `add`, `subtract`, `multiply`, `divide`: each has exactly `type`, `left`, and `right`.
- `{"type":"power","base":{...},"exponent":2}`: an integer exponent from −3 to 3.

Set `expectedUnit` to a catalog ID, or `null` to omit the final dimension comparison. Every declared variable must occur in the expression. Variable IDs determine collection order; reordering the variables or candidates does not change the session.

Limits: 1–8 variables, 63 nodes, depth 8 including the root, and a conservative absolute bound of 64 on each dimension exponent. Validation considers every candidate unit, so it may reject expressions whose eventual choices would fit. IDs start with a lowercase letter and use lowercase letters, digits, `_` or `-`: audit IDs allow 40 characters, variable IDs 16; variable IDs exclude prototype-related names. UTF-16 text limits are title 40, context/meaning 70, source 110, and owner label 60. Text must be trimmed, well-formed and single-line without control/format characters. Formula/config files are limited to 64/16 KiB; extra keys and undeclared references are rejected.

## Connect and collect

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Open the pairing link, approve the connection and choose a standard private room containing the source owner. Verify the person in the app and put their exact member UUID in `config.json`; names alone do not establish identity. Pairing resumes saved pending work. For an **existing connection only**, copy `.env.example` to `.env` and supply both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Blank or partial pairs are rejected.

```sh
npm start
# Answer in PingRoom, then run again to collect that answer.
npm start
# Repeat until status is complete or incomplete.
npm run status
npm run report
npm run export
```

Each invocation creates at most one Question or reads its result, with at most eight Questions per session, each lasting 15 minutes. Terminal results are retained; the next invocation can ask about the next variable. Expired, cancelled, unsupported or misattributed answers never become unit assignments.

`status` and `report` work offline. `report` saves `.dimensional-audit/report.json`, including partial evidence. After every variable has a valid known choice, offline `export` saves `.dimensional-audit/dimensional-audit.json`: canonical formula, catalog, hashes, attributed answers, assigned dimensions, node evidence, errors and blocked paths.

**Complete does not mean compatible.** A fully known mismatch has `status: "complete"`, `audit.consistent: false`, and remains exportable. Unknown or missing evidence produces no audit and blocks export. A successful process exit is not a passing dimensional verdict; consumers must inspect `audit.consistent`.

Addition and subtraction require matching operand dimensions. Multiplication adds exponents, division subtracts them, and powers multiply them. An incompatible node has no dimension; its parents are marked blocked. Even raising an incompatible child to zero stays blocked. Expected-output comparison runs only when the root dimension is known.

Dimensional compatibility cannot detect different physical quantities sharing dimensions, incorrect numbers, division by zero or invalid numerical domains. Zero constants remain dimensionless. The starter performs no symbolic simplification, numeric evaluation, unit conversion or physical correctness certification.

## Recovery and private files

A saved creation intent precedes every POST. If creation is uncertain, keep the state and use:

```sh
npm run find-id
npm run recover -- EXACT_LOWERCASE_QUESTION_UUID
```

Recovery verifies the original request, catalog, target, room, options, timestamps and asker. An empty search does not authorize another POST. There is no automatic resend or replacement Question.

Exit codes are `0` for a completed operation, `1` for configuration/operation failure, `2` for incomplete or newly failed evidence, `3` for pending/ready/stopped, and `4` for uncertain creation. Inspect the returned status as well.

Credentials, input and state are Git-ignored. Private directories/files use modes 0700/0600, bounded reads, locks and atomic writes. Keep `.pingroom/` and `.dimensional-audit/` private. Resolve uncertain remote work before archiving a session; never delete state to trigger another send. Changed source, formula, catalog, connection or participant cannot reuse saved evidence. Remove a stale lock only after confirming its recorded process stopped.

## Adapt it

Change the source excerpts, variable meanings, candidate units and typed formula for your workflow. Keep numerical execution in a separate application with its own checks. `src/model.js` owns validation and dimension arithmetic; `src/engine.js` owns durable collection and export.

Tests cover 11,172 small AST/unit combinations against an independent rational-prime oracle, all 49 catalog-unit/power cases, exact error paths, blocked parents, bounds, Unknown handling, SDK contracts, recovery, pairing and CLI behavior. Verification uses mocks; live phone delivery is not tested.

MIT licensed.
