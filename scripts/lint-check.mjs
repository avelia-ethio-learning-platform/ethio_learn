#!/usr/bin/env node
// Lint gate: runs ESLint in api/ and web/ and compares the problem count per
// rule with .github/lint-baseline.json. Existing findings don't fail it; a
// rule whose count went up does, and its findings are printed.
//   node scripts/lint-check.mjs            # check (CI's `lint` job)
//   node scripts/lint-check.mjs --update   # rewrite the baseline (after a PR lowers it)
// Needs both workspaces installed (pnpm install in api/ and web/).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE = join(ROOT, '.github/lint-baseline.json');
const PACKAGES = ['api', 'web'];

function lint(pkg) {
  const res = spawnSync('pnpm', ['-s', 'exec', 'eslint', '.', '-f', 'json'], { cwd: join(ROOT, pkg), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // ESLint exits 1 when it finds problems; only a missing or unparsable report is a failure here.
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    console.error(`eslint in ${pkg} produced no report (exit ${res.status}):\n${res.stderr}`);
    process.exit(2);
  }
  const findings = report.flatMap((file) =>
    file.messages.map((m) => ({ rule: m.ruleId ?? '(parse error)', where: `${pkg}/${relative(join(ROOT, pkg), file.filePath)}:${m.line}:${m.column}`, message: m.message })),
  );
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return { findings, counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) };
}

const results = Object.fromEntries(PACKAGES.map((pkg) => [pkg, lint(pkg)]));

if (process.argv.includes('--update')) {
  const baseline = Object.fromEntries(PACKAGES.map((pkg) => [pkg, results[pkg].counts]));
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`baseline written: ${PACKAGES.map((pkg) => `${pkg} ${results[pkg].findings.length}`).join(', ')}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
let risen = 0;
for (const pkg of PACKAGES) {
  const { findings, counts } = results[pkg];
  const before = baseline[pkg] ?? {};
  const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  console.log(`${pkg}: ${findings.length} problem(s), baseline ${total(before)}`);
  for (const [rule, count] of Object.entries(counts)) {
    const allowed = before[rule] ?? 0;
    if (count <= allowed) continue;
    risen += 1;
    console.log(`\n  ${rule}: ${allowed} → ${count}. Its findings (the new ones are among them):`);
    for (const f of findings.filter((x) => x.rule === rule)) console.log(`    ${f.where}  ${f.message}`);
  }
  const lowered = Object.entries(before).filter(([rule, n]) => (counts[rule] ?? 0) < n);
  if (lowered.length) console.log(`  lower than the baseline (${lowered.map(([r]) => r).join(', ')}): run node scripts/lint-check.mjs --update and commit it`);
}
if (risen) {
  console.log(`\nLint problems went up for ${risen} rule(s). Fix the new ones; the existing ones don't block.`);
  process.exit(1);
}
console.log('\nNo rule above its baseline.');
