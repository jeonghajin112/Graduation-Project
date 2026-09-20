import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const AUDIT_RETENTION = { days: 14, successfulRunsPerSuite: 10 };
const sceneNames = new Set(['input', 'analyze', 'report', 'overview']);

// Check every component, including Windows junctions. Never follow a link or
// recursively delete a directory: unknown files and reports stay in place.
function checkedFile(root, file) {
  root = path.resolve(root);
  file = path.resolve(file);
  const relative = path.relative(root, file);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Artifact path outside root');
  let current = root;
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    let stats;
    try { stats = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    assert.ok(!stats.isSymbolicLink(), 'Artifact links are not cleaned');
    if (current === file) return stats;
    assert.ok(stats.isDirectory(), 'Artifact parent must be a directory');
  }
}

function removeFiles(root, files, apply) {
  // Complete preflight before deleting the first file.
  const candidates = files.map(file => {
    const stats = checkedFile(root, file);
    assert.ok(stats?.isFile(), 'Cleanup requires a regular file');
    return { path: file, bytes: stats.size };
  });
  if (apply) for (const file of candidates) {
    const stats = checkedFile(root, file.path);
    assert.ok(stats?.isFile() && stats.size === file.bytes, 'Artifact changed during cleanup');
    unlinkSync(file.path);
  }
  return candidates;
}

export function cleanupRecordingFrames(dashboard, output, {
  completed = false, stillsOnly = false, keepFrames = false, scenes = []
} = {}) {
  if (!completed || stillsOnly || keepFrames) return [];
  const recordings = path.resolve(dashboard, 'artifacts/landing-recordings');
  output = path.resolve(output);
  assert.equal(path.dirname(output), recordings, 'Expected a direct recording session');
  assert.ok(checkedFile(dashboard, output)?.isDirectory(), 'Recording session missing');
  if (checkedFile(dashboard, path.join(output, '.keep'))) return [];
  assert.ok(scenes.length > 0, 'No verified scenes');
  const files = new Set();
  for (const { scene, verified } of scenes) {
    assert.ok(sceneNames.has(scene) && verified === true, 'Unverified recording scene');
    // ffmpeg must have finished every encode before this helper is called.
    // Validate all scenes before removing any frames, including resumed scenes.
    for (const relative of [
      `${scene}.png`, `media/${scene}.webp`,
      ...['', '-1440', '-1080'].map(suffix => `media/vid/${scene}${suffix}.mp4`)
    ]) {
      const stats = checkedFile(dashboard, path.join(output, relative));
      assert.ok(stats?.isFile() && stats.size > 0, 'Encoded recording output missing or empty');
    }
    const directory = path.join(output, scene);
    const stats = checkedFile(dashboard, directory);
    if (!stats) continue; // An already cleaned recording may be resumed.
    assert.ok(stats.isDirectory(), 'Recording frames must be a directory');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^\d{4}\.png$/.test(entry.name)) files.add(path.join(directory, entry.name));
    }
  }
  return removeFiles(dashboard, [...files], true);
}

export function cleanupTestArtifacts(dashboard, { apply = false, now = Date.now() } = {}) {
  assert.ok(Number.isFinite(now), 'Invalid retention clock');
  const root = path.resolve(dashboard, 'artifacts/frontend-tests');
  if (!checkedFile(dashboard, root)) return [];
  const runs = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);
    try {
      const reportFile = path.join(directory, 'results.json');
      if (!checkedFile(dashboard, reportFile)?.isFile()) continue;
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      const completed = Date.parse(report.completedAt);
      const started = Date.parse(report.startedAt);
      if (report.status !== 'passed' || typeof report.suite !== 'string' || !report.suite ||
          !Number.isFinite(completed) || !Number.isFinite(started) || completed < started || completed > now ||
          report.notRunCount !== 0 || !Array.isArray(report.results) || !report.results.length ||
          !Array.isArray(report.selectedTests) || report.selectedTests.length !== report.results.length ||
          !report.results.every(result => result.status === 'passed' && result.code === 0 &&
            typeof result.logFile === 'string' && /^\d+-[\w.-]+\.mjs\.log$/.test(result.logFile))) continue;
      runs.push({ directory, report, completed });
    } catch {
      // Incomplete, locked, malformed or linked reports are never cleanup input.
    }
  }
  runs.sort((a, b) => b.completed - a.completed || a.directory.localeCompare(b.directory));
  const counts = new Map();
  const files = new Set();
  const cutoff = now - AUDIT_RETENTION.days * 24 * 60 * 60 * 1000;
  for (const { directory, report, completed } of runs) {
    const count = (counts.get(report.suite) ?? 0) + 1;
    counts.set(report.suite, count);
    if (count <= AUDIT_RETENTION.successfulRunsPerSuite || completed >= cutoff) continue;
    try {
      if (checkedFile(dashboard, path.join(directory, '.keep'))) continue;
      const logs = report.results.map(result => path.join(directory, result.logFile));
      const existing = logs.filter(file => checkedFile(dashboard, file)?.isFile());
      for (const file of existing) files.add(file);
    } catch {
      // Preserve the entire run if any log points through a link.
    }
  }
  return removeFiles(dashboard, [...files], apply);
}
