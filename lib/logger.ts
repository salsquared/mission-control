export type LogEntry = {
    id: string;
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
};

const LOG_LIMIT = 500;

type LogListener = (log: LogEntry) => void;

// Use global to persist across hot-reloads in dev
const globalForLogs = global as unknown as {
    __SYSTEM_LOGS: LogEntry[];
    __LOGGER_INITIALIZED: boolean;
    __LOG_LISTENERS: Set<LogListener>;
};

if (!globalForLogs.__SYSTEM_LOGS) {
    globalForLogs.__SYSTEM_LOGS = [];
}
if (!globalForLogs.__LOG_LISTENERS) {
    globalForLogs.__LOG_LISTENERS = new Set();
}

export function subscribeToLogs(listener: LogListener) {
    globalForLogs.__LOG_LISTENERS.add(listener);
    return () => {
        globalForLogs.__LOG_LISTENERS.delete(listener);
    };
}

export function initLogger() {
    if (globalForLogs.__LOGGER_INITIALIZED) return;
    globalForLogs.__LOGGER_INITIALIZED = true;

    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    const originalConsoleInfo = console.info;

    const stripAnsi = (str: string) => {
        return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    };

    const addLog = (level: LogEntry['level'], args: any[]) => {
        const message = args.map(arg => {
            if (arg === null) return 'null';
            if (arg === undefined) return 'undefined';
            if (arg instanceof Error) {
                return stripAnsi(arg.stack || arg.message);
            }
            if (typeof arg === 'object') {
                try {
                    return stripAnsi(JSON.stringify(arg));
                } catch {
                    return stripAnsi(String(arg)); // Handle circular references safely
                }
            }
            return stripAnsi(String(arg));
        }).join(' ');

        const newLog = {
            id: Math.random().toString(36).substring(2, 11),
            timestamp: new Date().toISOString(),
            level,
            message
        };

        globalForLogs.__SYSTEM_LOGS.push(newLog);

        if (globalForLogs.__SYSTEM_LOGS.length > LOG_LIMIT) {
            globalForLogs.__SYSTEM_LOGS.shift();
        }

        // Notify subscribers
        globalForLogs.__LOG_LISTENERS.forEach(listener => listener(newLog));
    };

    let inConsoleCall = false;

    console.log = (...args) => {
        addLog('info', args);
        inConsoleCall = true;
        originalConsoleLog.apply(console, args);
        inConsoleCall = false;
    };

    console.info = (...args) => {
        addLog('info', args);
        inConsoleCall = true;
        originalConsoleInfo.apply(console, args);
        inConsoleCall = false;
    };

    console.warn = (...args) => {
        addLog('warn', args);
        inConsoleCall = true;
        originalConsoleWarn.apply(console, args);
        inConsoleCall = false;
    };

    console.error = (...args) => {
        addLog('error', args);
        inConsoleCall = true;
        originalConsoleError.apply(console, args);
        inConsoleCall = false;
    };

    const addRawLog = (level: LogEntry['level'], rawMessage: string) => {
        const message = stripAnsi(rawMessage).trim();
        if (!message) return; // ignore empty strings or just newlines

        const newLog = {
            id: Math.random().toString(36).substring(2, 11),
            timestamp: new Date().toISOString(),
            level,
            message
        };

        globalForLogs.__SYSTEM_LOGS.push(newLog);

        if (globalForLogs.__SYSTEM_LOGS.length > LOG_LIMIT) {
            globalForLogs.__SYSTEM_LOGS.shift();
        }

        globalForLogs.__LOG_LISTENERS.forEach(listener => listener(newLog));
    };

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk: Uint8Array | string, encodingOrCb?: any, cb?: any) {
        if (!inConsoleCall) {
            const rawMessage = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
            addRawLog('info', rawMessage);
        }
        return originalStdoutWrite(chunk, encodingOrCb, cb);
    } as any;

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = function (chunk: Uint8Array | string, encodingOrCb?: any, cb?: any) {
        if (!inConsoleCall) {
            const rawMessage = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
            addRawLog('error', rawMessage);
        }
        return originalStderrWrite(chunk, encodingOrCb, cb);
    } as any;
}

export function getLogs() {
    return globalForLogs.__SYSTEM_LOGS;
}
