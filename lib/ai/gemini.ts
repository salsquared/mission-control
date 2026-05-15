import { GoogleGenAI } from "@google/genai";
import type { z } from "zod";

const DEFAULT_MODEL = "gemini-2.5-flash";

export class AIError extends Error {
    constructor(
        message: string,
        readonly cause?: unknown,
        readonly stage: "config" | "request" | "parse" | "validate" = "request",
    ) {
        super(message);
        this.name = "AIError";
    }
}

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
    if (cachedClient) return cachedClient;
    const apiKey =
        process.env.GOOGLE_GENERATIVE_AI_KEY ||
        process.env.GOOGLE_GEN_AI_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        throw new AIError(
            "No Google GenAI key found. Set GOOGLE_GENERATIVE_AI_KEY (preferred) or one of GOOGLE_GEN_AI_KEY / GEMINI_API_KEY / GOOGLE_API_KEY in .env. Get a free key at https://aistudio.google.com/apikey.",
            undefined,
            "config",
        );
    }
    cachedClient = new GoogleGenAI({ apiKey });
    return cachedClient;
}

interface ChatJSONOptions<T> {
    system?: string;
    user: string;
    schema: z.ZodSchema<T>;
    model?: string;
    temperature?: number;
}

interface RetryConfig {
    attempts: number;
    baseDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = { attempts: 3, baseDelayMs: 800 };

function isRetryable(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { status?: number; code?: number; message?: string };
    const status = e.status ?? e.code;
    if (status === 429) return true;
    if (typeof status === "number" && status >= 500 && status < 600) return true;
    if (typeof e.message === "string" && /\b(429|503|502|504|UNAVAILABLE|RESOURCE_EXHAUSTED)\b/i.test(e.message)) return true;
    return false;
}

async function withRetry<T>(fn: () => Promise<T>, config: RetryConfig = DEFAULT_RETRY): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < config.attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || i === config.attempts - 1) throw err;
            const delay = config.baseDelayMs * 2 ** i;
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

/**
 * Run a single-turn JSON-mode prompt against Gemini and validate the response
 * against the provided Zod schema. Returns the typed, validated result.
 *
 * Adding a real prompt? Route it through this helper, not the SDK directly —
 * one place to handle retries, env-var checks, and token logging.
 */
export async function chatJSON<T>(opts: ChatJSONOptions<T>): Promise<T> {
    const client = getClient();
    const model = opts.model ?? DEFAULT_MODEL;

    const response = await withRetry(() =>
        client.models.generateContent({
            model,
            contents: opts.user,
            config: {
                responseMimeType: "application/json",
                temperature: opts.temperature ?? 0.4,
                ...(opts.system ? { systemInstruction: opts.system } : {}),
            },
        }),
    ).catch((err: unknown) => {
        throw new AIError(`Gemini request failed: ${err instanceof Error ? err.message : String(err)}`, err, "request");
    });

    const usage = response.usageMetadata;
    if (usage) {
        console.info(
            `[AI] ${model} tokens: prompt=${usage.promptTokenCount ?? "?"} candidates=${usage.candidatesTokenCount ?? "?"} total=${usage.totalTokenCount ?? "?"}`,
        );
    }

    const text = response.text;
    if (!text) {
        throw new AIError("Gemini returned an empty response", response, "parse");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new AIError(
            `Gemini response was not valid JSON: ${text.slice(0, 200)}…`,
            err,
            "parse",
        );
    }

    const validation = opts.schema.safeParse(parsed);
    if (!validation.success) {
        throw new AIError(
            `Gemini response failed schema validation: ${validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            validation.error,
            "validate",
        );
    }
    return validation.data;
}
