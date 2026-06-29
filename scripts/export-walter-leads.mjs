#!/usr/bin/env node
/**
 * export-walter-leads.mjs — VSH file-based bridge (career-ops -> Walter Job Search App)
 *
 * Reads the career-ops application tracker (data/applications.md, a pipe-delimited
 * markdown table) and exports selected opportunities as versioned lead JSON files
 * for the Walter Job Search App to import and run CHB triage on.
 *
 * SAFETY / SCOPE (per security audit — file bridge first):
 *   - Read-only on career-ops data. Does NOT modify the tracker.
 *   - No external API calls. No credentials. No Walter app API calls.
 *   - Does NOT submit or apply to anything. Leads are routing-only (triage_only),
 *     manual_submission_only:true, package_generation_allowed:false.
 *
 * Tracker format (data/applications.md), columns mapped by header NAME:
 *   | # | Date | Company | Role | [Location] | Score | Status | PDF | Report | Notes |
 *   Score cells look like "4.20/5", "N/A", or "DUP".
 *
 * Usage:
 *   node scripts/export-walter-leads.mjs [options]
 * Options:
 *   --source <path>   Tracker markdown to read (default: data/applications.md)
 *   --jds-dir <path>  Directory of JD markdown files to attach as descriptions (default: jds)
 *   --out <dir>       Output dir for lead JSON (default: C:\Walter\Jobs\leads\incoming)
 *   --limit N         Export at most N leads (after filtering)
 *   --min-score X     Only export leads with career_ops_score >= X (0..5 scale)
 *   --status S        Only export leads whose Status matches S (case-insensitive substring)
 *   --dry-run         Parse and report, but write nothing
 *   --json            Print a machine-readable JSON summary to stdout
 */

import fs from 'fs';
import path from 'path';

const SCHEMA_VERSION = 'walter_jobs_lead.v1';
const DEFAULT_OUT = path.join('C:', 'Walter', 'Jobs', 'leads', 'incoming');

// ── arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    source: path.join('data', 'applications.md'),
    jdsDir: 'jds',
    out: DEFAULT_OUT,
    limit: Infinity,
    minScore: -Infinity,
    status: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--source': opts.source = next(); break;
      case '--jds-dir': opts.jdsDir = next(); break;
      case '--out': opts.out = next(); break;
      case '--limit': opts.limit = parseInt(next(), 10); break;
      case '--min-score': opts.minScore = parseFloat(next()); break;
      case '--status': opts.status = String(next()).toLowerCase(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    }
  }
  if (Number.isNaN(opts.limit)) opts.limit = Infinity;
  return opts;
}

// ── tracker parsing ──────────────────────────────────────────────────────────
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

// Parse "4.20/5" -> 4.2 ; "N/A"/"DUP"/"" -> null
function parseScore(cell) {
  const m = String(cell || '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return m ? parseFloat(m[1]) : null;
}

function isSeparatorRow(cells) {
  // | --- | :---: | etc.
  return cells.every(c => /^:?-{2,}:?$/.test(c) || c === '');
}

/**
 * Parse a pipe-delimited markdown tracker table. Maps columns by header name so
 * an optional Location column (or other extras) does not shift fields.
 * Returns an array of row objects keyed by lowercased header.
 */
function parseTracker(md) {
  const lines = md.split(/\r?\n/);
  let headerCells = null;
  const rows = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim());
    // drop leading/trailing empties from the split around outer pipes
    if (cells.length && cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue;

    if (!headerCells) {
      // The header is the first row containing both Company and Role.
      const lower = cells.map(c => c.toLowerCase());
      if (lower.includes('company') && lower.includes('role')) {
        headerCells = lower;
      }
      continue;
    }
    if (isSeparatorRow(cells)) continue;

    const row = {};
    for (let ci = 0; ci < headerCells.length; ci++) {
      row[headerCells[ci]] = cells[ci] !== undefined ? cells[ci] : '';
    }
    // Skip rows with no company/role (blank/malformed)
    if (!row.company && !row.role) continue;
    row.__line = li + 1;
    rows.push(row);
  }
  return rows;
}

// ── lead building ────────────────────────────────────────────────────────────
function findJdDescription(jdsDir, company, role) {
  if (!jdsDir) return '';
  try {
    if (!fs.existsSync(jdsDir)) return '';
    const want = slug(`${company}-${role}`);
    const files = fs.readdirSync(jdsDir).filter(f => /\.(md|txt)$/i.test(f));
    // exact-ish match first, then company-only
    let hit = files.find(f => slug(f.replace(/\.[^.]+$/, '')) === want);
    if (!hit) hit = files.find(f => slug(f).includes(slug(company)) && slug(f).includes(slug(role)));
    if (!hit) return '';
    return fs.readFileSync(path.join(jdsDir, hit), 'utf8').trim();
  } catch { return ''; }
}

function buildLead(row, opts, sourceFile) {
  const company = row.company || '';
  const role = row.role || '';
  const score = parseScore(row.score);
  const dedupeKey = `${slug(company)}::${slug(role)}`;
  const jobId = `${slug(company)}-${slug(role)}`;
  const description = findJdDescription(opts.jdsDir, company, role)
    || [role, company, row.notes].filter(Boolean).join(' — ');

  return {
    schema_version: SCHEMA_VERSION,
    source: 'career-ops',
    exported_at: new Date().toISOString(),
    job: {
      job_id: jobId,
      title: role,
      company,
      location: row.location || '',
      url: '',
      description,
      source_provider: 'career-ops-tracker',
      salary: '',
      remote: null,
      posting_status: row.status || '',
      career_ops_score: score,
      career_ops_status: row.status || '',
    },
    routing: {
      requested_mode: 'triage_only',
      manual_submission_only: true,
      package_generation_allowed: false,
    },
    provenance: {
      career_ops_file: sourceFile,
      career_ops_line: row.__line ?? null,
      dedupe_key: dedupeKey,
    },
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
function run(argv) {
  const opts = parseArgs(argv);

  if (!fs.existsSync(opts.source)) {
    const msg = `Tracker source not found: ${opts.source} (no opportunities to export). ` +
      `Populate data/applications.md or pass --source <file>.`;
    if (opts.json) { console.log(JSON.stringify({ ok: false, error: msg, exported: 0 }, null, 2)); }
    else { console.error(msg); }
    return { ok: false, error: msg, leads: [] };
  }

  const md = fs.readFileSync(opts.source, 'utf8');
  const rows = parseTracker(md);

  let leads = rows.map(r => buildLead(r, opts, opts.source));

  // filters
  if (opts.status) {
    leads = leads.filter(l => (l.job.career_ops_status || '').toLowerCase().includes(opts.status));
  }
  if (opts.minScore > -Infinity) {
    leads = leads.filter(l => l.job.career_ops_score !== null && l.job.career_ops_score >= opts.minScore);
  }
  if (Number.isFinite(opts.limit)) {
    leads = leads.slice(0, opts.limit);
  }

  const manifest = {
    schema_version: 'walter_jobs_lead_manifest.v1',
    source: 'career-ops',
    generated_at: new Date().toISOString(),
    source_file: opts.source,
    out_dir: opts.out,
    count: leads.length,
    filters: { limit: opts.limit === Infinity ? null : opts.limit, min_score: opts.minScore === -Infinity ? null : opts.minScore, status: opts.status },
    manual_submission_only: true,
    package_generation_allowed: false,
    leads: leads.map(l => ({ job_id: l.job.job_id, file: `${l.job.job_id}.json`, company: l.job.company, title: l.job.title, career_ops_score: l.job.career_ops_score, dedupe_key: l.provenance.dedupe_key })),
  };

  if (!opts.dryRun) {
    fs.mkdirSync(opts.out, { recursive: true });
    for (const lead of leads) {
      fs.writeFileSync(path.join(opts.out, `${lead.job.job_id}.json`), JSON.stringify(lead, null, 2), 'utf8');
    }
    // manifest lives one level up from incoming/ (the leads root)
    const manifestPath = path.join(path.dirname(opts.out), 'manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dry_run: opts.dryRun, count: leads.length, manifest }, null, 2));
  } else {
    console.log(`${opts.dryRun ? '[dry-run] ' : ''}Parsed ${rows.length} tracker row(s); exported ${leads.length} lead(s).`);
    for (const l of leads) console.log(`  - ${l.job.company} / ${l.job.title}  (score ${l.job.career_ops_score ?? '—'}, status ${l.job.career_ops_status || '—'})`);
    if (!opts.dryRun) console.log(`Wrote leads to ${opts.out} and manifest to ${path.join(path.dirname(opts.out), 'manifest.json')}`);
  }

  return { ok: true, leads, manifest };
}

// Export for tests; run when invoked directly.
export { parseArgs, parseTracker, parseScore, buildLead, slug, run };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  try { run(process.argv.slice(2)); }
  catch (e) { console.error('export-walter-leads error:', e.message); process.exit(1); }
}
