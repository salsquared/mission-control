#!/usr/bin/env tsx
/*
 * Long-running performance monitor for the dev (or prod) PM2 process.
 *
 * Samples PM2's reported RSS + CPU every N seconds and writes JSONL to
 * data/perf/<startTs>.jsonl. Uses `pm2 jlist` so the monitor is an
 * independent observer — it never hits the server's own /api/system
 * endpoint (which is itself part of what we're trying to measure).
 *
 * Workflow for fix-by-fix measurement:
 *
 *   1. Start the monitor.
 *   2. Type `label baseline` + Enter, leave it for ~2 min.
 *   3. Apply fix, `pm2 restart mission-control-dev`.
 *   4. Type `label after-fix-1` + Enter, leave for ~2 min.
 *   5. Repeat for each fix.
 *   6. Ctrl-C → prints a per-label median/p95/max summary table and
 *      writes a sibling .md file next to the JSONL.
 *
 * Env:
 *   MC_PERF_PROCESS     — PM2 process name to watch (default: mission-control-dev)
 *   MC_PERF_INTERVAL_MS — sample interval (default: 5000)
 *
 * Run with:  npx tsx scripts/perf-monitor.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const exec = promisify(execFile);

const PROCESS_NAME = process.env.MC_PERF_PROCESS ?? 'mission-control-dev';
const INTERVAL_MS = Number(process.env.MC_PERF_INTERVAL_MS ?? 5000);
const OUT_DIR = path.join(process.cwd(), 'data', 'perf');

type Sample = {
    ts: string;
    label: string;
    pm2_id: number | null;
    // PM2 reports the npm wrapper, not the next-server worker. We walk the
    // process tree from the PM2-tracked PID and sum descendant RSS so the
    // numbers actually match what /api/system shows in the UI. `rss_bytes`
    // is the SUM (npm + next dev + next-server), which is the right number
    // for "service load". `worker_rss_bytes` and `worker_cpu_pct` are just
    // the next-server worker, which is what dominates and what the dash
    // displays.
    rss_bytes: number | null;
    worker_rss_bytes: number | null;
    cpu_pct: number | null;
    worker_cpu_pct: number | null;
    descendant_count: number | null;
    uptime_s: number | null;
    restarts: number | null;
    status: string | null;
};

type PsRow = { pid: number; ppid: number; rss: number; cpu: number; cmd: string };

async function readPsTree(): Promise<Map<number, PsRow>> {
    const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,rss=,pcpu=,command=']);
    const map = new Map<number, PsRow>();
    for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
        if (!m) continue;
        map.set(+m[1], {
            pid: +m[1],
            ppid: +m[2],
            rss: +m[3] * 1024,
            cpu: +m[4],
            cmd: m[5],
        });
    }
    return map;
}

function walkTree(rootPid: number, ps: Map<number, PsRow>): PsRow[] {
    const byParent = new Map<number, PsRow[]>();
    for (const row of ps.values()) {
        if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
        byParent.get(row.ppid)!.push(row);
    }
    const out: PsRow[] = [];
    const queue = [rootPid];
    while (queue.length) {
        const pid = queue.shift()!;
        const node = ps.get(pid);
        if (node) out.push(node);
        for (const k of byParent.get(pid) ?? []) queue.push(k.pid);
    }
    return out;
}

const samples: Sample[] = [];
let currentLabel = process.argv[2] ?? 'baseline';
let stopping = false;

async function readPm2(): Promise<Sample | null> {
    const now = new Date().toISOString();
    const nullSample: Sample = {
        ts: now, label: currentLabel, pm2_id: null,
        rss_bytes: null, worker_rss_bytes: null,
        cpu_pct: null, worker_cpu_pct: null,
        descendant_count: null, uptime_s: null, restarts: null, status: null,
    };
    try {
        const [{ stdout: pmStdout }, ps] = await Promise.all([
            exec('pm2', ['jlist']),
            readPsTree(),
        ]);
        const list = JSON.parse(pmStdout);
        const proc = list.find((p: any) => p.name === PROCESS_NAME);
        if (!proc) return { ...nullSample, status: 'missing' };

        const rootPid = proc.pid;
        const tree = rootPid ? walkTree(rootPid, ps) : [];
        const totalRss = tree.reduce((s, r) => s + r.rss, 0) || null;
        const totalCpu = tree.length ? tree.reduce((s, r) => s + r.cpu, 0) : null;
        // The next-server worker is the leaf that actually serves HTTP. Fall
        // back to the deepest descendant if "next-server" isn't in the cmd
        // string (different Next version, etc).
        const worker = tree.find(r => /next-server/.test(r.cmd)) ?? tree[tree.length - 1] ?? null;

        const uptimeMs = proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null;
        return {
            ts: now,
            label: currentLabel,
            pm2_id: proc.pm_id ?? null,
            rss_bytes: totalRss,
            worker_rss_bytes: worker?.rss ?? null,
            cpu_pct: totalCpu,
            worker_cpu_pct: worker?.cpu ?? null,
            descendant_count: tree.length,
            uptime_s: uptimeMs != null ? Math.round(uptimeMs / 1000) : null,
            restarts: proc.pm2_env?.restart_time ?? null,
            status: proc.pm2_env?.status ?? null,
        };
    } catch (e: any) {
        return { ...nullSample, status: `error: ${e?.message ?? e}` };
    }
}

function fmtBytes(n: number | null | undefined) {
    if (n == null || Number.isNaN(n)) return '----';
    const mb = n / 1024 / 1024;
    if (mb >= 1024) return (mb / 1024).toFixed(2) + 'GB';
    return mb.toFixed(0) + 'MB';
}

function pct(arr: number[], p: number) {
    if (!arr.length) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function summarize() {
    const byLabel = new Map<string, Sample[]>();
    for (const s of samples) {
        if (s.worker_rss_bytes == null && s.rss_bytes == null) continue;
        if (!byLabel.has(s.label)) byLabel.set(s.label, []);
        byLabel.get(s.label)!.push(s);
    }
    if (!byLabel.size) {
        console.log('No samples collected.');
        return '';
    }
    let md = `# perf-monitor summary\n\n`;
    md += `Process: \`${PROCESS_NAME}\`  ·  interval: ${INTERVAL_MS}ms  ·  total samples: ${samples.length}\n\n`;
    md += `RSS / CPU columns are the **next-server worker** (the real HTTP server, what /api/system shows in the UI). Tree-total numbers (npm + next dev + worker) follow in parens.\n\n`;
    md += `| Label | n | Worker RSS median | p95 | max | Worker CPU median | p95 | max | Tree RSS max |\n`;
    md += `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
    console.log('\n--- perf-monitor summary ---');
    for (const [label, rows] of byLabel) {
        const wrss = rows.map(r => r.worker_rss_bytes!).filter(x => x != null) as number[];
        const wcpu = rows.map(r => r.worker_cpu_pct!).filter(x => x != null) as number[];
        const trss = rows.map(r => r.rss_bytes!).filter(x => x != null) as number[];
        const rssMed = pct(wrss, 0.5);
        const rssP95 = pct(wrss, 0.95);
        const rssMax = wrss.length ? Math.max(...wrss) : 0;
        const cpuMed = wcpu.length ? pct(wcpu, 0.5) : 0;
        const cpuP95 = wcpu.length ? pct(wcpu, 0.95) : 0;
        const cpuMax = wcpu.length ? Math.max(...wcpu) : 0;
        const tRssMax = trss.length ? Math.max(...trss) : 0;
        md += `| ${label} | ${rows.length} | ${fmtBytes(rssMed)} | ${fmtBytes(rssP95)} | ${fmtBytes(rssMax)} | ${cpuMed.toFixed(1)}% | ${cpuP95.toFixed(1)}% | ${cpuMax.toFixed(1)}% | ${fmtBytes(tRssMax)} |\n`;
        console.log(`  ${label.padEnd(22)} n=${String(rows.length).padStart(4)}  worker RSS med ${fmtBytes(rssMed)}  p95 ${fmtBytes(rssP95)}  max ${fmtBytes(rssMax)}   CPU med ${cpuMed.toFixed(1)}%  p95 ${cpuP95.toFixed(1)}%  max ${cpuMax.toFixed(1)}%`);
    }
    console.log('----------------------------\n');
    return md;
}

async function main() {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const startTs = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(OUT_DIR, `${startTs}.jsonl`);
    const handle = await fs.open(outPath, 'a');
    console.log(`perf-monitor -> ${outPath}`);
    console.log(`process=${PROCESS_NAME} interval=${INTERVAL_MS}ms label="${currentLabel}"`);
    console.log(`type 'label <name>' + Enter to tag subsequent samples. Ctrl-C to stop.\n`);

    const rl = createInterface({ input: process.stdin });
    rl.on('line', line => {
        const m = line.trim().match(/^label\s+(.+)$/);
        if (m) {
            currentLabel = m[1].trim();
            console.log(`[label] -> ${currentLabel}`);
        } else if (line.trim()) {
            console.log(`(unknown command - use 'label <name>')`);
        }
    });

    const tick = async () => {
        if (stopping) return;
        const s = await readPm2();
        if (!s) return;
        samples.push(s);
        await handle.write(JSON.stringify(s) + '\n');
        const stamp = new Date(s.ts).toLocaleTimeString();
        const wrss = fmtBytes(s.worker_rss_bytes).padStart(7);
        const trss = fmtBytes(s.rss_bytes).padStart(7);
        const wcpu = (s.worker_cpu_pct ?? 0).toFixed(1).padStart(4);
        const tcpu = (s.cpu_pct ?? 0).toFixed(1).padStart(4);
        const up = s.uptime_s != null ? `${s.uptime_s}s` : '?';
        const restarts = s.restarts != null ? `${s.restarts}` : '?';
        const procs = s.descendant_count ?? '?';
        console.log(`[${stamp}] ${s.label.padEnd(22)} worker=${wrss} ${wcpu}%  tree=${trss} ${tcpu}% (${procs} procs)  up=${up} ↺${restarts}`);
    };

    const handler = async () => {
        if (stopping) return;
        stopping = true;
        try { await tick(); } catch { /* best-effort final sample */ }
        await handle.close();
        const md = summarize();
        if (md) {
            const mdPath = outPath.replace(/\.jsonl$/, '.md');
            await fs.writeFile(mdPath, md);
            console.log(`summary -> ${mdPath}`);
        }
        process.exit(0);
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);

    await tick();
    setInterval(tick, INTERVAL_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
