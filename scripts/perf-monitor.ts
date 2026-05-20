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
    rss_bytes: number | null;
    cpu_pct: number | null;
    uptime_s: number | null;
    restarts: number | null;
    status: string | null;
};

const samples: Sample[] = [];
let currentLabel = process.argv[2] ?? 'baseline';
let stopping = false;

async function readPm2(): Promise<Sample | null> {
    const now = new Date().toISOString();
    try {
        const { stdout } = await exec('pm2', ['jlist']);
        const list = JSON.parse(stdout);
        const proc = list.find((p: any) => p.name === PROCESS_NAME);
        if (!proc) {
            return {
                ts: now, label: currentLabel,
                pm2_id: null, rss_bytes: null, cpu_pct: null,
                uptime_s: null, restarts: null, status: 'missing',
            };
        }
        const uptimeMs = proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null;
        return {
            ts: now,
            label: currentLabel,
            pm2_id: proc.pm_id ?? null,
            rss_bytes: proc.monit?.memory ?? null,
            cpu_pct: proc.monit?.cpu ?? null,
            uptime_s: uptimeMs != null ? Math.round(uptimeMs / 1000) : null,
            restarts: proc.pm2_env?.restart_time ?? null,
            status: proc.pm2_env?.status ?? null,
        };
    } catch (e: any) {
        return {
            ts: now, label: currentLabel,
            pm2_id: null, rss_bytes: null, cpu_pct: null,
            uptime_s: null, restarts: null, status: `error: ${e?.message ?? e}`,
        };
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
        if (s.rss_bytes == null) continue;
        if (!byLabel.has(s.label)) byLabel.set(s.label, []);
        byLabel.get(s.label)!.push(s);
    }
    if (!byLabel.size) {
        console.log('No samples collected.');
        return '';
    }
    let md = `# perf-monitor summary\n\n`;
    md += `Process: \`${PROCESS_NAME}\`  ·  interval: ${INTERVAL_MS}ms  ·  total samples: ${samples.length}\n\n`;
    md += `| Label | n | RSS median | RSS p95 | RSS max | CPU median | CPU p95 | CPU max |\n`;
    md += `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
    console.log('\n--- perf-monitor summary ---');
    for (const [label, rows] of byLabel) {
        const rss = rows.map(r => r.rss_bytes!).filter(x => x != null);
        const cpu = rows.map(r => r.cpu_pct!).filter(x => x != null);
        const rssMed = pct(rss, 0.5);
        const rssP95 = pct(rss, 0.95);
        const rssMax = Math.max(...rss);
        const cpuMed = cpu.length ? pct(cpu, 0.5) : 0;
        const cpuP95 = cpu.length ? pct(cpu, 0.95) : 0;
        const cpuMax = cpu.length ? Math.max(...cpu) : 0;
        md += `| ${label} | ${rows.length} | ${fmtBytes(rssMed)} | ${fmtBytes(rssP95)} | ${fmtBytes(rssMax)} | ${cpuMed.toFixed(0)}% | ${cpuP95.toFixed(0)}% | ${cpuMax.toFixed(0)}% |\n`;
        console.log(`  ${label.padEnd(22)} n=${String(rows.length).padStart(4)}  RSS med ${fmtBytes(rssMed)}  p95 ${fmtBytes(rssP95)}  max ${fmtBytes(rssMax)}   CPU med ${cpuMed.toFixed(0)}%  p95 ${cpuP95.toFixed(0)}%  max ${cpuMax.toFixed(0)}%`);
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
        const rss = fmtBytes(s.rss_bytes).padStart(7);
        const cpu = String(s.cpu_pct ?? '?').padStart(3);
        const up = s.uptime_s != null ? `${s.uptime_s}s` : '?';
        const restarts = s.restarts != null ? `${s.restarts}` : '?';
        console.log(`[${stamp}] ${s.label.padEnd(22)} RSS=${rss}  CPU=${cpu}%  up=${up}  restarts=${restarts}  ${s.status ?? ''}`);
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
