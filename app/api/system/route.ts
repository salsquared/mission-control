import { NextResponse } from 'next/server';
import os from 'os';
import { prisma } from '@/lib/prisma';

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

export async function GET() {
    try {
        // Process CPU Usage (since last request)
        const currentCpuUsage = process.cpuUsage(lastCpuUsage);
        const currentCpuTime = Date.now();

        // Convert microseconds to milliseconds
        const elapsedUserMs = currentCpuUsage.user / 1000;
        const elapsedSystemMs = currentCpuUsage.system / 1000;
        const totalElapsedCpuMs = elapsedUserMs + elapsedSystemMs;

        const elapsedTimeMs = currentCpuTime - lastCpuTime;

        // Calculate percentage (can be slightly >100% on multi-core if highly parallel, but capping at 100 for simplicity)
        // If elapsed time is 0 (first quick request), default to 0%
        const cpuUsagePercent = elapsedTimeMs > 0
            ? Math.min(100, Math.round((totalElapsedCpuMs / elapsedTimeMs) * 100))
            : 0;

        // Update state for next request
        lastCpuUsage = process.cpuUsage();
        lastCpuTime = currentCpuTime;

        // Process Memory Usage
        const memUsage = process.memoryUsage();
        const usedMemRSS = memUsage.rss; // Resident Set Size (total memory allocated for process)

        const usedMemGB = (usedMemRSS / (1024 ** 3)).toFixed(2);

        // Let's implement a soft 4GB visual limit to monitor its resources
        const maxMemSysLimitGB = 4; // A defined 4GB limit 
        const memoryUsageFormatted = `${usedMemGB} GB / ${maxMemSysLimitGB} GB`;

        // Process Uptime (Server specifically, instead of whole system)
        const uptimeSeconds = process.uptime();
        const days = Math.floor(uptimeSeconds / (3600 * 24));
        const hours = Math.floor((uptimeSeconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);

        let uptimeFormatted = '';
        if (days > 0) uptimeFormatted += `${days}d `;
        if (hours > 0) uptimeFormatted += `${hours}h `;
        uptimeFormatted += `${minutes}m`;

        let dbConnected = false;
        try {
            await prisma.$queryRaw`SELECT 1`;
            dbConnected = true;
        } catch (e) {
            console.warn("DB connection check failed:", e);
        }

        return NextResponse.json({
            cpuUsagePercent,
            memoryUsageFormatted,
            uptimeFormatted,
            dbConnected
        });
    } catch (error) {
        console.error("Error fetching system telemetry:", error);
        return NextResponse.json({ error: "Failed to fetch system telemetry" }, { status: 500 });
    }
}
