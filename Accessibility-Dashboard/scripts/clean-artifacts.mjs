import { fileURLToPath } from 'node:url';
import { cleanupTestArtifacts, AUDIT_RETENTION } from './artifact-retention.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--help'].includes(arg))) {
  throw new Error('Usage: npm run artifacts:clean -- [--apply]');
}
if (args.includes('--help')) {
  console.log('Preview expired successful test logs; --apply deletes the listed files.');
  console.log(`Keep ${AUDIT_RETENTION.days} days and ${AUDIT_RETENTION.successfulRunsPerSuite} successful runs per suite. Reports, failed/active runs and .keep runs stay.`);
} else {
  const apply = args.includes('--apply');
  const files = cleanupTestArtifacts(fileURLToPath(new URL('..', import.meta.url)), { apply });
  console.log(JSON.stringify({ mode: apply ? 'deleted' : 'preview', files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0) }, null, 2));
}
