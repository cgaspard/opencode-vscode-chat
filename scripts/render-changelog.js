#!/usr/bin/env node
// Render every releasenotes/<version>.yaml into CHANGELOG.md, newest first.
//
// The Marketplace shows CHANGELOG.md as its own tab, so it has to ship in the
// .vsix — but a hand-maintained copy of notes that already exist as YAML only
// ever drifts. This regenerates it from the same source the GitHub Release
// body is rendered from, so the two can never disagree.
//
//   node scripts/render-changelog.js          # write CHANGELOG.md
//   node scripts/render-changelog.js --check  # exit 1 if it is out of date
//
// Run it after adding a release notes file; `--check` is the CI guard.

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NOTES_DIR = path.join(ROOT, 'releasenotes');
const OUT = path.join(ROOT, 'CHANGELOG.md');

/** Semver descending, so the newest release is what you see first. */
function compareDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pb[i] || 0) - (pa[i] || 0);
    }
  }
  return 0;
}

const versions = fs
  .readdirSync(NOTES_DIR)
  .filter((f) => /^\d+\.\d+\.\d+\.yaml$/.test(f))
  .map((f) => f.replace(/\.yaml$/, ''))
  .sort(compareDesc);

if (!versions.length) {
  console.error('No releasenotes/<version>.yaml files found');
  process.exit(2);
}

const sections = versions.map((v) =>
  cp
    .execFileSync(process.execPath, [path.join(__dirname, 'render-release-notes.js'), v, '--no-footer'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    .trim()
    // A release body is its own document and starts at `# v0.2.0`. Here every
    // release nests under one `# Changelog`, so push each heading down a level.
    .replace(/^(#{1,5}) /gm, '$1# '),
);

const displayName = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).displayName;

const body =
  [
    '# Changelog',
    '',
    `All notable changes to ${displayName}. Generated from \`releasenotes/*.yaml\``,
    'by `scripts/render-changelog.js` — edit those, not this file.',
    '',
    ...sections.flatMap((s) => [s, '']),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== body) {
    console.error('CHANGELOG.md is out of date — run: node scripts/render-changelog.js');
    process.exit(1);
  }
  console.log(`CHANGELOG.md is up to date (${versions.length} release${versions.length === 1 ? '' : 's'})`);
  process.exit(0);
}

fs.writeFileSync(OUT, body);
console.log(`Wrote ${OUT} (${versions.length} release${versions.length === 1 ? '' : 's'}: ${versions.join(', ')})`);
