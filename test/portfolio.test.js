const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pf = require('../src/main/portfolio');

test('slugify and titleCase turn folder names into ids and titles', () => {
  assert.equal(pf.slugify('Voxel MTG'), 'voxel-mtg');
  assert.equal(pf.slugify('aurora-and-space_weather'), 'aurora-and-space-weather');
  assert.equal(pf.slugify('myCoolApp'), 'my-cool-app');
  assert.equal(pf.slugify('Gestão Financeira'), 'gestao-financeira');
  assert.equal(pf.titleCase('earthquake-globe'), 'Earthquake Globe');
});

test('githubUrl normalizes ssh and https remotes', () => {
  assert.equal(pf.githubUrl('git@github.com:davipferr/f1-replay.git'), 'https://github.com/davipferr/f1-replay');
  assert.equal(pf.githubUrl('https://github.com/davipferr/f1-replay.git\n'), 'https://github.com/davipferr/f1-replay');
  assert.equal(pf.githubUrl('https://gitlab.com/x/y.git'), null);
});

test('readmeIntro skips headings, badges, code and lists', () => {
  const md = [
    '<div align="center">',
    '',
    '# 🧰 Tool',
    '',
    '![badge](https://img.shields.io/x) ![b](y)',
    '',
    'A **small** tool that makes [CSS](https://x) properties visible.',
    '',
    '```bash',
    'npm install',
    '```',
    '',
    '- a list item that should be skipped',
    '',
    '`npm test` runs the unit tests, so this setup note is skipped.',
    '',
    'Second paragraph with enough words to count.',
    '',
    'Third paragraph is past the limit.',
  ].join('\n');
  assert.deepEqual(pf.readmeIntro(md), [
    'A small tool that makes CSS properties visible.',
    'Second paragraph with enough words to count.',
  ]);
});

test('guessCategory and guessTags read the scan types and dependencies', () => {
  assert.equal(pf.guessCategory(['node'], { three: '1', vite: '1' }), '3d');
  assert.equal(pf.guessCategory(['node'], { electron: '1' }), 'desktop');
  assert.equal(pf.guessCategory(['node'], { react: '1' }), 'web');
  assert.equal(pf.guessCategory(['python'], {}), 'data');
  assert.equal(pf.guessCategory(['rust'], {}), 'tools');
  assert.deepEqual(pf.guessTags(['node'], { typescript: '1', three: '1', vite: '1' }), ['typescript', 'threejs', 'vite']);
  assert.deepEqual(pf.guessTags(['node'], {}), ['javascript', 'node']);
});

test('cleanEntry keeps known fields in order and drops empty optionals', () => {
  const e = pf.cleanEntry({
    slug: 'demo', title: ' Demo ', tagline: { en: 'x', pt: 'y' }, description: { en: 'a', pt: 'b' },
    category: 'web', constellation: '', tags: 'TypeScript, three js', repoUrl: '', liveUrl: 'https://x.dev',
    featured: false, date: '2026-01-01', status: 'active', evil: 'ignored',
  });
  assert.deepEqual(Object.keys(e), ['$schema', 'slug', 'title', 'tagline', 'description', 'category', 'tags', 'liveUrl', 'date', 'status']);
  assert.equal(e.title, 'Demo');
  assert.deepEqual(e.tags, ['typescript', 'three-js']);
  assert.throws(() => pf.cleanEntry({ ...e, slug: '../evil' }), /Slug/);
});

/** A tiny fake portfolio whose `npm run validate` fails when a tagline has no "pt". */
function fakePortfolio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  fs.mkdirSync(path.join(dir, 'content', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'content', 'project.schema.json'), '{}');
  fs.writeFileSync(
    path.join(dir, 'validate.js'),
    `const fs = require('fs'), d = 'content/projects';
     for (const f of fs.readdirSync(d)) {
       const e = JSON.parse(fs.readFileSync(d + '/' + f, 'utf8'));
       if (!e.tagline.pt) { console.error(f + ': /tagline must have pt'); process.exit(1); }
     }
     console.log('valid');`,
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { validate: 'node validate.js' } }));
  return dir;
}

const entry = {
  slug: 'demo', title: 'Demo', tagline: { en: 'x', pt: 'y' }, description: { en: 'a', pt: 'b' },
  category: 'web', tags: [], date: '2026-01-01',
};

test('save writes the entry when validate passes', async () => {
  const dir = fakePortfolio();
  try {
    const res = await pf.save(dir, entry);
    assert.equal(res.ok, true, res.output);
    assert.equal(res.created, true);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'content', 'projects', 'demo.json'), 'utf8'));
    assert.equal(written.$schema, '../project.schema.json');
    assert.equal(written.title, 'Demo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save puts the old file back when validate fails', async () => {
  const dir = fakePortfolio();
  const file = path.join(dir, 'content', 'projects', 'demo.json');
  try {
    // a brand-new invalid entry leaves nothing behind
    let res = await pf.save(dir, { ...entry, tagline: { en: 'x', pt: '' } });
    assert.equal(res.ok, false);
    assert.match(res.output, /tagline must have pt/);
    assert.equal(fs.existsSync(file), false);

    // an invalid edit restores the previous version
    await pf.save(dir, entry);
    const before = fs.readFileSync(file, 'utf8');
    res = await pf.save(dir, { ...entry, title: 'Changed', tagline: { en: 'x', pt: '' } });
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pagesUrl guesses the GitHub Pages URL from a deploy-pages workflow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  try {
    assert.equal(await pf.pagesUrl(dir, 'https://github.com/me/app'), undefined);
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'steps:\n  - uses: actions/deploy-pages@v4\n');
    assert.equal(await pf.pagesUrl(dir, 'https://github.com/Me/app'), 'https://me.github.io/app/');
    assert.equal(await pf.pagesUrl(dir, 'https://github.com/me/me.github.io'), 'https://me.github.io/');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove deletes the entry and its images, and only plain slugs', async () => {
  const dir = fakePortfolio();
  try {
    await pf.save(dir, entry);
    const images = path.join(dir, 'public', 'projects', 'demo');
    fs.mkdirSync(images, { recursive: true });
    fs.writeFileSync(path.join(images, 'cover.webp'), 'x');

    const res = await pf.remove(dir, 'demo');
    assert.equal(res.slug, 'demo');
    assert.equal(fs.existsSync(path.join(dir, 'content', 'projects', 'demo.json')), false);
    assert.equal(fs.existsSync(images), false);

    await assert.rejects(pf.remove(dir, 'demo'), /No portfolio entry/);
    await assert.rejects(pf.remove(dir, '../package'), /Invalid slug/);
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prefill reads an existing entry, else guesses from the project files', async () => {
  const dir = fakePortfolio();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  try {
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ description: 'A neat thing.', devDependencies: { vite: '1', typescript: '1' } }));
    fs.writeFileSync(path.join(proj, 'README.md'), '# Neat Thing — the long subtitle\n\nIt does neat things for people who like neat things.\n');
    const p = { name: path.basename(proj), path: proj, types: ['node'], isGit: false };

    let res = await pf.prefill(dir, p);
    assert.equal(res.existing, false);
    assert.equal(res.entry.title, 'Neat Thing');
    assert.equal(res.entry.tagline.en, 'A neat thing.');
    assert.equal(res.entry.tagline.pt, '');
    assert.equal(res.entry.category, 'web');
    assert.deepEqual(res.entry.tags, ['typescript', 'vite']);

    await pf.save(dir, { ...entry, slug: res.entry.slug, title: 'Saved Title' });
    res = await pf.prefill(dir, p);
    assert.equal(res.existing, true);
    assert.equal(res.entry.title, 'Saved Title');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
