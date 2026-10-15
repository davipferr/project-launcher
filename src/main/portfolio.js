// "Add to portfolio": turns a local project into an entry of the portfolio
// site (davipferr.github.io). The site is data-driven: one JSON file per
// project in <portfolio>/content/projects/<slug>.json, checked by the site's
// own `npm run validate`. This module only writes that file; committing and
// pushing stay with the user.
const fs = require('node:fs/promises');
const path = require('node:path');
const { exec, execFile } = require('node:child_process');

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG = /^[a-z0-9][a-z0-9.+#-]*$/;
const FIELDS_ORDER = [
  'slug', 'title', 'tagline', 'description', 'category', 'constellation', 'tags',
  'repoUrl', 'liveUrl', 'cover', 'images', 'featured', 'date', 'status',
];

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** A folder is the portfolio if it has the content schema the site validates against. */
async function isPortfolio(dir) {
  return !!dir && (await exists(path.join(dir, 'content', 'project.schema.json'))) && (await exists(path.join(dir, 'content', 'projects')));
}

const projectsDir = (portfolio) => path.join(portfolio, 'content', 'projects');
const entryFile = (portfolio, slug) => {
  if (!SLUG.test(slug)) throw new Error(`Invalid slug: ${slug}`);
  return path.join(projectsDir(portfolio), `${slug}.json`);
};

// ---- prefill helpers (pure, tested) -----------------------------------------

function slugify(name) {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "earthquake-globe" -> "Earthquake Globe" */
function titleCase(name) {
  return String(name)
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** git@github.com:user/repo.git or https://github.com/user/repo.git -> https://github.com/user/repo */
function githubUrl(remote) {
  const m = String(remote || '').trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** First real paragraphs of a README: skips headings, badges, HTML, code and lists. */
function readmeIntro(md, maxParas = 2) {
  const text = String(md || '').replace(/\r\n/g, '\n').replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const paras = [];
  for (const block of text.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b || /^(#|<|!\[|\[!\[|[-*+] |\d+\. |\||>)/.test(b)) continue;
    const plain = b
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
      .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (plain.length < 20) continue;
    // setup notes ("`npm test` runs the tests") are not a description
    if (/`(npm|pnpm|yarn|npx|node|pip|python|cargo|dotnet|go|docker) /.test(b)) continue;
    paras.push(plain);
    if (paras.length >= maxParas) break;
  }
  return paras;
}

const firstSentence = (s) => (String(s).match(/^.*?[.!?](?=\s|$)/) || [s])[0].trim();

const DEP_TAGS = {
  three: 'threejs', react: 'react', vue: 'vue', svelte: 'svelte', 'solid-js': 'solid', next: 'nextjs',
  electron: 'electron', vite: 'vite', typescript: 'typescript', express: 'express', fastify: 'fastify',
  tailwindcss: 'tailwind', d3: 'd3', 'socket.io': 'websockets', pg: 'postgresql', mysql2: 'mysql',
  prisma: 'prisma', '@playwright/test': 'playwright', 'three-mesh-bvh': 'threejs', '@huggingface/transformers': 'ai',
};
const TYPE_TAGS = { python: 'python', rust: 'rust', go: 'go', dotnet: 'csharp', docker: 'docker', angular: 'angular', mql5: 'mql5' };

/** Tags and a category from what the scan detected plus package.json deps. */
function guessTags(types, deps) {
  const tags = [];
  const add = (t) => t && !tags.includes(t) && tags.push(t);
  if (deps.typescript) add('typescript');
  else if (types.includes('node')) add('javascript');
  for (const d of Object.keys(deps)) add(DEP_TAGS[d]);
  for (const t of types) add(TYPE_TAGS[t]);
  if (types.includes('node') && !deps.vite && !deps.react && !deps.electron && !deps.three) add('node');
  return tags.slice(0, 8);
}

function guessCategory(types, deps) {
  if (deps.electron) return 'desktop';
  if (deps.three || deps['@react-three/fiber'] || deps.babylonjs) return '3d';
  if (deps.d3 || deps['chart.js'] || deps.plotly || types.includes('python')) return 'data';
  if (deps.express || deps.fastify || deps['@nestjs/core'] || types.includes('docker') || types.includes('dotnet')) return 'backend';
  if (deps.react || deps.vue || deps.svelte || deps.vite || deps.next || types.includes('static') || types.includes('angular')) return 'web';
  if (types.length) return 'tools';
  return 'other';
}

/**
 * Normalize what the form sent into a clean entry: known fields only, trimmed,
 * empty optionals dropped, keys in the order the other entries use.
 */
function cleanEntry(input) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const text = (v) => ({ en: str(v?.en), pt: str(v?.pt) });
  const e = {
    slug: str(input.slug),
    title: str(input.title),
    tagline: text(input.tagline),
    description: text(input.description),
    category: str(input.category),
    constellation: str(input.constellation) || undefined,
    tags: [...new Set((Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(','))
      .map((t) => str(String(t)).toLowerCase().replace(/\s+/g, '-'))
      .filter(Boolean))],
    repoUrl: str(input.repoUrl) || undefined,
    liveUrl: str(input.liveUrl) || undefined,
    cover: str(input.cover) || undefined,
    images: Array.isArray(input.images) && input.images.length ? input.images.map(str).filter(Boolean) : undefined,
    featured: input.featured ? true : undefined,
    date: str(input.date),
    status: str(input.status) || undefined,
  };
  if (!SLUG.test(e.slug)) throw new Error('Slug must be lowercase words joined by dashes, e.g. my-project');
  const bad = e.tags.find((t) => !TAG.test(t));
  if (bad) throw new Error(`Invalid tag "${bad}": use lowercase letters, numbers, dashes`);
  const out = { $schema: '../project.schema.json' };
  for (const k of FIELDS_ORDER) if (e[k] !== undefined) out[k] = e[k];
  return out;
}

// ---- I/O ------------------------------------------------------------------------

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

/** Options the form needs from the portfolio itself: categories, zodiac figures and how full they are. */
async function options(portfolio) {
  const schema = await readJson(path.join(portfolio, 'content', 'project.schema.json'));
  const zodiac = await readJson(path.join(portfolio, 'src', 'data', 'zodiac.json'));
  const entries = await listEntries(portfolio);
  const used = {};
  for (const e of entries) if (e.constellation) used[e.constellation] = (used[e.constellation] || 0) + 1;
  return {
    categories: schema?.properties?.category?.enum ?? [],
    statuses: schema?.properties?.status?.enum ?? [],
    constellations: (zodiac?.constellations ?? []).map((z) => ({ id: z.id, name: z.name, stars: z.stars.length, used: used[z.id] || 0 })),
  };
}

async function listEntries(portfolio) {
  let files = [];
  try {
    files = (await fs.readdir(projectsDir(portfolio))).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return (await Promise.all(files.map((f) => readJson(path.join(projectsDir(portfolio), f))))).filter(Boolean);
}

/** The entry for a project, if it is already in the portfolio: by remembered slug, else by folder name. */
async function findEntry(portfolio, proj, rememberedSlug) {
  for (const slug of [rememberedSlug, slugify(proj.name)].filter(Boolean)) {
    const data = SLUG.test(slug) && (await readJson(entryFile(portfolio, slug)));
    if (data) return data;
  }
  return null;
}

/** A filled-in entry for the form: the existing one, or a best guess from the project's files. */
async function prefill(portfolio, proj, rememberedSlug) {
  const existing = await findEntry(portfolio, proj, rememberedSlug);
  if (existing) return { entry: existing, existing: true };

  const pkg = (await readJson(path.join(proj.path, 'package.json'))) || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let readme = '';
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    try {
      readme = await fs.readFile(path.join(proj.path, name), 'utf8');
      break;
    } catch {
      // try the next spelling
    }
  }
  const intro = readmeIntro(readme);
  const heading = readme.match(/^#\s+(.+)$/m)?.[1]
    .replace(/[*_`]/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '') // leading emoji
    .split(/\s+[—–-]\s+|:\s/)[0] // "Name — long subtitle"
    .trim();
  const title = (heading && heading.length <= 60 && heading) || pkg.productName || titleCase(proj.name);
  const tagline = (pkg.description || (intro[0] ? firstSentence(intro[0]) : '')).trim();
  const firstCommit = proj.isGit ? (await git(proj.path, ['log', '--max-parents=0', '--format=%as'])).split('\n').pop() : '';
  const remote = proj.isGit ? await git(proj.path, ['remote', 'get-url', 'origin']) : '';
  const repoUrl = githubUrl(remote) || undefined;
  const homepage = typeof pkg.homepage === 'string' && /^https:\/\//.test(pkg.homepage) ? pkg.homepage : undefined;

  return {
    existing: false,
    entry: {
      slug: slugify(proj.name),
      title,
      tagline: { en: tagline, pt: '' },
      description: { en: intro.join('\n\n'), pt: '' },
      category: guessCategory(proj.types, deps),
      tags: guessTags(proj.types, deps),
      repoUrl,
      liveUrl: homepage || (await pagesUrl(proj.path, repoUrl)),
      date: firstCommit || new Date().toISOString().slice(0, 10),
      status: 'active',
    },
  };
}

/**
 * The GitHub Pages URL, when the repo deploys there with actions/deploy-pages:
 * https://<user>.github.io/<repo>/ (or the root for a <user>.github.io repo).
 */
async function pagesUrl(dir, repoUrl) {
  const m = repoUrl && repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (!m) return undefined;
  const wfDir = path.join(dir, '.github', 'workflows');
  let files = [];
  try {
    files = (await fs.readdir(wfDir)).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return undefined;
  }
  for (const f of files) {
    if ((await fs.readFile(path.join(wfDir, f), 'utf8')).includes('actions/deploy-pages')) {
      const user = m[1].toLowerCase();
      return m[2].toLowerCase() === `${user}.github.io` ? `https://${user}.github.io/` : `https://${user}.github.io/${m[2]}/`;
    }
  }
  return undefined;
}

/** Run the portfolio's own validator; it is the single source of truth for what is valid. */
function validate(portfolio) {
  return new Promise((resolve) => {
    exec('npm run validate --silent', { cwd: portfolio, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      resolve({ ok: !err, output, warnings: output.split('\n').filter((l) => l.startsWith('⚠')).map((l) => l.slice(1).trim()) });
    });
  });
}

/**
 * Write the entry and validate the whole portfolio. If validation fails the
 * file is put back the way it was, so a bad entry never sits in the repo.
 */
async function save(portfolio, input) {
  if (!(await isPortfolio(portfolio))) throw new Error(`Not a portfolio folder: ${portfolio}`);
  if (!(await exists(path.join(portfolio, 'node_modules')))) {
    throw new Error('The portfolio has no node_modules; run "npm install" in it first.');
  }
  const entry = cleanEntry(input);
  const file = entryFile(portfolio, entry.slug);
  const before = await fs.readFile(file, 'utf8').catch(() => null);
  await fs.writeFile(file, JSON.stringify(entry, null, 2) + '\n');
  const result = await validate(portfolio);
  if (!result.ok) {
    if (before === null) await fs.rm(file, { force: true });
    else await fs.writeFile(file, before);
  }
  return { ...result, file, slug: entry.slug, created: before === null };
}

module.exports = {
  isPortfolio, options, prefill, save, listEntries, pagesUrl,
  // exported for tests
  slugify, titleCase, githubUrl, readmeIntro, guessTags, guessCategory, cleanEntry,
};
