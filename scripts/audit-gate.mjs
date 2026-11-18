import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// HIGH and CRITICAL findings require an unexpired, package-specific exception.
try {
  const allow = JSON.parse(readFileSync(process.argv[3] ?? '.github/audit-allowlist.json', 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of allow) {
    if (!entry.advisory || !entry.package || !entry.reason ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiry) || entry.expiry < today) {
      throw new Error('Invalid or expired audit exception: ' + JSON.stringify(entry));
    }
  }
  let raw;
  if (process.argv[2]) raw = readFileSync(process.argv[2], 'utf8');
  else {
    const result = spawnSync('pnpm', ['audit', '--json'], { encoding: 'utf8' });
    if (result.error || ![0, 1].includes(result.status)) throw new Error(result.error ?? result.stderr);
    raw = result.stdout;
  }
  const audit = JSON.parse(raw);
  if (audit.error || !audit.advisories || !audit.metadata) throw new Error('Invalid audit response');
  const failures = Object.values(audit.advisories).filter(a =>
    ['high', 'critical'].includes(a.severity) &&
    !allow.some(e => e.advisory === a.github_advisory_id && e.package === a.module_name));
  if (failures.length) throw new Error('Unaccepted findings: ' + failures.map(a => a.github_advisory_id + ' ' + a.module_name).join(', '));
  console.log('Audit gate passed (HIGH/CRITICAL threshold).');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
