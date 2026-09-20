import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AUDIT_RETENTION, cleanupRecordingFrames, cleanupTestArtifacts } from './artifact-retention.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'artifact-retention-'));
  t.after(() => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('artifact-retention-'));
    rmSync(target, { recursive: true, force: true });
  });
  const dashboard = path.join(directory, 'dashboard');
  mkdirSync(dashboard);
  function write(relative, content = 'evidence') {
    const target = path.join(dashboard, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  }
  return { dashboard, directory, write };
}

function recording(f, name = 'session', scene = 'report') {
  const prefix = `artifacts/landing-recordings/${name}`;
  for (const file of [`${scene}.png`, `media/${scene}.webp`,
    ...['', '-1440', '-1080'].map(suffix => `media/vid/${scene}${suffix}.mp4`)]) f.write(`${prefix}/${file}`);
  const frame = f.write(`${prefix}/${scene}/0000.png`);
  f.write(`${prefix}/${scene}/0001.png`);
  const extra = f.write(`${prefix}/${scene}/notes.txt`);
  const manifest = f.write(`${prefix}/capture-manifest.json`, '{"sampleData":false}');
  const error = f.write(`${prefix}/capture-error.png`);
  return { output: path.join(f.dashboard, prefix), frame, extra, manifest, error,
    options: { completed: true, scenes: [{ scene, verified: true }] } };
}

test('successful recording removes only sequence frames and remains resumable', t => {
  const f = fixture(t);
  const r = recording(f);
  const removed = cleanupRecordingFrames(f.dashboard, r.output, r.options);
  assert.equal(removed.length, 2);
  assert.equal(existsSync(r.frame), false);
  for (const file of [r.extra, r.manifest, r.error, path.join(r.output, 'report.png'),
    path.join(r.output, 'media/report.webp'), path.join(r.output, 'media/vid/report.mp4')]) assert.ok(existsSync(file));
  assert.deepEqual(cleanupRecordingFrames(f.dashboard, r.output, r.options), []);
});

test('failed, still-only, explicitly kept and pinned recordings retain frames', t => {
  const f = fixture(t);
  const r = recording(f);
  for (const overrides of [{ completed: false }, { stillsOnly: true }, { keepFrames: true }]) {
    assert.deepEqual(cleanupRecordingFrames(f.dashboard, r.output, { ...r.options, ...overrides }), []);
    assert.ok(existsSync(r.frame));
  }
  f.write('artifacts/landing-recordings/session/.keep');
  assert.deepEqual(cleanupRecordingFrames(f.dashboard, r.output, r.options), []);
});

test('missing or empty encoding and unverified scenes preserve all frames', t => {
  const f = fixture(t);
  const r = recording(f);
  recording(f, 'session', 'overview');
  f.write('artifacts/landing-recordings/session/media/vid/overview-1080.mp4', '');
  assert.throws(() => cleanupRecordingFrames(f.dashboard, r.output, {
    ...r.options, scenes: [...r.options.scenes, { scene: 'overview', verified: true }]
  }), /missing or empty/);
  assert.ok(existsSync(r.frame));
  assert.throws(() => cleanupRecordingFrames(f.dashboard, r.output, {
    ...r.options, scenes: [{ scene: 'report', verified: false }]
  }), /Unverified/);
  rmSync(path.join(r.output, 'media/vid/report.mp4'));
  assert.throws(() => cleanupRecordingFrames(f.dashboard, r.output, r.options), /missing or empty/);
  assert.ok(existsSync(r.frame));
});

test('recording cleanup rejects traversal, unknown scenes and Windows junctions', t => {
  const f = fixture(t);
  const r = recording(f);
  assert.throws(() => cleanupRecordingFrames(f.dashboard, f.directory, r.options), /direct recording/);
  assert.throws(() => cleanupRecordingFrames(f.dashboard, r.output, {
    ...r.options, scenes: [{ scene: '../../public', verified: true }]
  }), /Unverified/);
  const linked = path.join(f.dashboard, 'artifacts/landing-recordings/linked');
  symlinkSync(r.output, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanupRecordingFrames(f.dashboard, linked, r.options), /links/);
  assert.ok(existsSync(r.frame));
});

const now = Date.parse('2026-09-20T12:00:00Z');
const day = 86_400_000;
function audit(f, name, age, overrides = {}) {
  const prefix = `artifacts/frontend-tests/${name}`;
  const report = {
    suite: 'ci', status: 'passed', startedAt: new Date(now - age * day - 1000).toISOString(),
    completedAt: new Date(now - age * day).toISOString(), notRunCount: 0,
    selectedTests: [{ file: 'verify-fixture.mjs' }],
    results: [{ file: 'verify-fixture.mjs', status: 'passed', code: 0, logFile: '01-verify-fixture.mjs.log' }],
    ...overrides
  };
  const reportFile = f.write(`${prefix}/results.json`, JSON.stringify(report));
  const log = f.write(`${prefix}/01-verify-fixture.mjs.log`);
  return { log, reportFile, prefix };
}
function recentRuns(f) {
  for (let i = 0; i < AUDIT_RETENTION.successfulRunsPerSuite; i++) audit(f, `recent-${i}`, i);
}

test('retention keeps latest ten per suite AND fourteen days; preview is read-only', t => {
  const f = fixture(t);
  recentRuns(f);
  const expired = audit(f, 'expired', 30);
  const withinDays = audit(f, 'within-days', 12);
  const boundary = audit(f, 'boundary', 14);
  const otherSuite = audit(f, 'browser-old', 50, { suite: 'browser' });
  const script = f.write(`${expired.prefix}/probe.mjs`);
  const db = f.write(`${expired.prefix}/backup.mv.db`);
  const unlisted = f.write(`${expired.prefix}/unlisted.log`);
  const before = readFileSync(expired.reportFile, 'utf8');
  const preview = cleanupTestArtifacts(f.dashboard, { now });
  assert.deepEqual(preview.map(file => file.path), [expired.log]);
  assert.ok(existsSync(expired.log));
  assert.deepEqual(cleanupTestArtifacts(f.dashboard, { now, apply: true }), preview);
  assert.equal(existsSync(expired.log), false);
  for (const file of [withinDays.log, boundary.log, otherSuite.log, script, db, unlisted]) assert.ok(existsSync(file));
  assert.equal(readFileSync(expired.reportFile, 'utf8'), before);
  assert.deepEqual(cleanupTestArtifacts(f.dashboard, { now, apply: true }), []);
});

test('ten successful runs are retained even when all are older than fourteen days', t => {
  const f = fixture(t);
  const runs = Array.from({ length: 12 }, (_, i) => audit(f, `old-${i}`, 20 + i));
  const files = cleanupTestArtifacts(f.dashboard, { now, apply: true });
  assert.deepEqual(files.map(file => file.path), runs.slice(10).map(run => run.log));
  for (const run of runs.slice(0, 10)) assert.ok(existsSync(run.log));
});

test('failed, running, partial, malformed, future and pinned audits are preserved', t => {
  const f = fixture(t);
  recentRuns(f);
  const variants = [
    { status: 'failed' }, { status: 'running', completedAt: null }, { completedAt: null },
    { notRunCount: 1 }, { completedAt: 'invalid' },
    { completedAt: new Date(now + day).toISOString() }, { results: [] },
    { results: [{ status: 'passed', code: 7, logFile: '01-verify-fixture.mjs.log' }] },
    { results: [{ status: 'passed', code: 0, logFile: '../../outside.log' }] }
  ];
  const runs = variants.map((override, i) => audit(f, `preserve-${i}`, 30, override));
  const malformed = audit(f, 'malformed', 30);
  writeFileSync(malformed.reportFile, '{broken');
  const pinned = audit(f, 'pinned', 30);
  f.write(`${pinned.prefix}/.keep`);
  assert.deepEqual(cleanupTestArtifacts(f.dashboard, { now, apply: true }), []);
  for (const run of [...runs, malformed, pinned]) assert.ok(existsSync(run.log));
});

test('linked audit runs and linked artifact roots never delete their targets', t => {
  const f = fixture(t);
  recentRuns(f);
  const outside = path.join(f.directory, 'outside');
  mkdirSync(outside);
  const keep = path.join(outside, '01-verify-fixture.mjs.log');
  writeFileSync(keep, 'outside evidence');
  const eligible = audit(f, 'ordinary-expired', 30);
  writeFileSync(path.join(outside, 'results.json'), readFileSync(eligible.reportFile));
  symlinkSync(outside, path.join(f.dashboard, 'artifacts/frontend-tests/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(cleanupTestArtifacts(f.dashboard, { now, apply: true }).map(file => file.path), [eligible.log]);
  assert.equal(readFileSync(keep, 'utf8'), 'outside evidence');
  const otherDashboard = path.join(f.directory, 'other-dashboard');
  mkdirSync(otherDashboard);
  symlinkSync(path.join(f.dashboard, 'artifacts'), path.join(otherDashboard, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanupTestArtifacts(otherDashboard, { now, apply: true }), /links/);
});

test('cleanup CLI supports help, rejects typos and defaults to a read-only preview from any cwd', () => {
  const cli = fileURLToPath(new URL('./clean-artifacts.mjs', import.meta.url));
  const options = { cwd: tmpdir(), encoding: 'utf8', windowsHide: true };
  assert.match(execFileSync(process.execPath, [cli, '--help'], options), /Preview/);
  assert.throws(() => execFileSync(process.execPath, [cli, '--aply'], { ...options, stdio: 'pipe' }));
  const preview = JSON.parse(execFileSync(process.execPath, [cli], options));
  assert.equal(preview.mode, 'preview');
  assert.ok(Array.isArray(preview.files));
});
