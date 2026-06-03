#!/usr/bin/env node
// Self-contained catalog generator for the plugin-localizer/catalog repo.
// No dependencies beyond Node 20+ (global fetch). Rebuilds plugin-index.json
// from the GitHub sources listed in index-sources.json.
//
//   GITHUB_TOKEN=ghp_xxx node build-plugin-index.mjs
//
// Only MIT/Unlicense repos are included; plugins containing @no-localize are
// skipped (author opt-out). On a per-repo fetch failure the repo's existing
// entries are kept, so a transient outage never drops plugins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'plugin-index.json');
const SOURCES = path.join(__dirname, 'index-sources.json');
const TOKEN = process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';
const TAG_KEYWORDS = ['battle','map','menu','ui','event','message','audio','save','title','picture','animation','item','skill','actor','enemy','utility'];

const OPT_OUT_RE = /@no-?(?:locali[sz]e|translate)\b/i;
export function hasOptOutMarker(src) { return !!src && OPT_OUT_RE.test(src); }

export function splitRepoDir(repoDir) {
  const parts = (repoDir || '').split('-');
  if (parts.length < 2) return [];
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push([parts.slice(0, i).join('-'), parts.slice(i).join('-')]);
  return out;
}

// Minimal annotation read: scan /*: blocks and prefer the default/English one
// (the catalog shows English descriptions). Returns author/plugindesc/target/help.
export function extractMeta(src) {
  if (!src) return null;
  const norm = src.replace(/\r\n/g, '\n');
  const re = /\/\*:([\w-]*)[^\n]*\n([\s\S]*?)\*\//g;
  const blocks = [];
  let m;
  while ((m = re.exec(norm))) blocks.push({ locale: m[1] || '', body: m[2] });
  if (!blocks.length) return null;
  const pick = blocks.find(b => b.locale === '' || b.locale.toLowerCase() === 'en') || blocks[0];
  const body = pick.body;
  const tag = (name) => {
    const mm = body.match(new RegExp('^\\s*\\*\\s*@' + name + '\\s*(.*)$', 'mi'));
    return mm ? mm[1].trim() : '';
  };
  return { author: tag('author'), plugindesc: tag('plugindesc'), target: tag('target'), help: body };
}

export function detectTarget(meta, src) {
  const t = (meta.target || '').toUpperCase();
  if (t.includes('MZ') && t.includes('MV')) return 'MV/MZ';
  if (t.includes('MZ')) return 'MZ';
  if (t.includes('MV')) return 'MV';
  if (/PluginManager\.registerCommand/.test(src || '')) return 'MZ';
  // No @target and no MZ-only API: MZ plugins almost always declare @target,
  // so treat the remainder as MV (MV-era plugins omit @target).
  return 'MV';
}

export function deriveTags(text) {
  const hay = (text || '').toLowerCase();
  return TAG_KEYWORDS.filter(t => hay.includes(t));
}

// Detect an MIT/Unlicense declaration in the plugin's own header. Many authors
// state the license in the file even when the repository has no LICENSE file
// (common for Japanese plugin authors). Returns 'MIT' / 'Unlicense' / null.
export function detectLicenseFromSource(src) {
  if (!src) return null;
  const head = src.slice(0, 8000);
  if (/Unlicense|public\s+domain/i.test(head)) return 'Unlicense';
  if (/MIT\s+Licen[sc]e|MITライセンス|releas\w*\s+under\s+(the\s+)?MIT|under\s+the\s+MIT|@licen[sc]e\s+MIT|licen[sc]e[:：]?\s*MIT|ライセンス[:：]?\s*MIT/i.test(head)) return 'MIT';
  return null;
}

export function pluginSourceToEntry(src, { owner, repo, relativePath, license }) {
  if (hasOptOutMarker(src)) return null;
  const meta = extractMeta(src);
  if (!meta) return null;
  if (!meta.plugindesc && !meta.author) return null;
  return {
    filename: relativePath.split('/').pop(),
    author: meta.author,
    repoDir: `${owner}-${repo}`,
    relativePath,
    description: meta.plugindesc,
    target: detectTarget(meta, src),
    tags: deriveTags(`${relativePath} ${meta.plugindesc} ${meta.help}`),
    license,
  };
}

function ghHeaders() {
  const h = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'plugin-localizer-catalog' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}
async function ghJson(url) {
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(r.headers.get('x-ratelimit-reset') || 0) * 1000;
    await new Promise(s => setTimeout(s, Math.max(0, reset - Date.now()) + 1000));
    return ghJson(url);
  }
  if (!r.ok) throw new Error(`GitHub ${r.status} ${url}`);
  return r.json();
}
async function ghRaw(owner, repo, branch, p) {
  const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`);
  if (!r.ok) throw new Error(`raw ${r.status} ${p}`);
  return r.text();
}
async function resolveRepo(spec) {
  if (spec.includes('/')) { const [owner, repo] = spec.split('/'); return { owner, repo }; }
  for (const [owner, repo] of splitRepoDir(spec)) {
    const info = await ghJson(`${API}/repos/${owner}/${repo}`);
    if (info && info.full_name) return { owner, repo };
  }
  return null;
}
async function listUserRepos(user) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const repos = await ghJson(`${API}/users/${user}/repos?per_page=100&page=${page}`);
    if (!repos || repos.length === 0) break;
    out.push(...repos.map(r => ({ owner: user, repo: r.name })));
    if (repos.length < 100) break;
  }
  return out;
}
async function listJsFiles(owner, repo, branch) {
  const tree = await ghJson(`${API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
  if (!tree || !Array.isArray(tree.tree)) return [];
  return tree.tree.filter(n => n.type === 'blob' && /\.js$/i.test(n.path) && !/\.min\.js$/i.test(n.path)).map(n => n.path);
}

async function main() {
  if (!TOKEN) console.warn('[warn] GITHUB_TOKEN not set — API limited to 60 req/h.');
  const cfg = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  const allowed = new Set(cfg.allowedLicenses || ['MIT', 'Unlicense']);
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
  const byRepoDir = {};
  for (const e of existing) { (byRepoDir[e.repoDir] || (byRepoDir[e.repoDir] = [])).push(e); }

  const specs = [...(cfg.repos || []), ...(cfg.repoDirs || [])];
  const repos = [];
  for (const spec of specs) { const r = await resolveRepo(spec); if (r) repos.push(r); else console.warn('[skip] cannot resolve ' + spec); }
  for (const user of cfg.users || []) repos.push(...await listUserRepos(user));

  const result = [];
  for (const { owner, repo } of repos) {
    const repoDir = `${owner}-${repo}`;
    try {
      const info = await ghJson(`${API}/repos/${owner}/${repo}`);
      const repoSpdx = (info && info.license && info.license.spdx_id) || '';
      const branch = info.default_branch || 'main';
      const files = await listJsFiles(owner, repo, branch);
      let kept = 0;
      for (const p of files) {
        try {
          const src = await ghRaw(owner, repo, branch, p);
          // Trust the repo SPDX when it is MIT/Unlicense; otherwise fall back
          // to a license declared in the plugin's own header (so repos without
          // a LICENSE file but with MIT-licensed plugins are still included).
          const license = allowed.has(repoSpdx) ? repoSpdx : detectLicenseFromSource(src);
          if (!license || !allowed.has(license)) continue;
          const entry = pluginSourceToEntry(src, { owner, repo, relativePath: p, license });
          if (entry) { result.push(entry); kept++; }
        } catch (_) { /* skip file */ }
      }
      console.log(`[ok] ${repoDir}: ${kept} plugin(s)`);
    } catch (e) {
      const fb = byRepoDir[repoDir] || [];
      result.push(...fb);
      console.warn(`[keep] ${repoDir}: ${e.message}; kept ${fb.length}`);
    }
  }
  result.sort((a, b) => a.repoDir.localeCompare(b.repoDir) || a.relativePath.localeCompare(b.relativePath));
  console.log(`Total: ${result.length} entries`);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 0) + '\n');
  console.log(`Wrote ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
