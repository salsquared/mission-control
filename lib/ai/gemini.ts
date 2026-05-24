import { GoogleGenAI } from "@google/genai";
import lunary from "lunary";
import type { z } from "zod";
import { acquireGeminiSlot } from "@/lib/ai/rate-limit";

// LOP-3: gate Lunary wrapping at module-init so dev / test / CI runs without
// the public key are a true no-op (no queueing, no event loop hits). When
// LUNARY_PUBLIC_KEY is unset, `tracedGenerate` is just `rawGenerate`.
const LUNARY_ENABLED = Boolean(process.env.LUNARY_PUBLIC_KEY);

// Three-tier model fleet. See `docs/llm-calls.md` for the per-callsite
// rationale; the short version:
//
//   MODEL_FLASH      — full Flash. Quality-sensitive paths only (resume bullet
//                       rewrite is the only current caller). Most expensive.
//   MODEL_LITE       — cheap-but-capable Flash-lite. Default for mechanical
//                       extraction at moderate volume (email classifier,
//                       posting parse, profile import, discovery suggest).
//   MODEL_LITE_CHEAP — outright cheapest. Pure-enum / picker tasks where the
//                       output space is tiny and quality drop is invisible
//                       (employment-type classifier).
//
// All three are pinned explicitly. Bump these constants — not the
// `*-latest` aliases — when Google ships a new generation; that way model
// changes are deliberate code changes and the cost/quality tradeoff stays
// auditable.
export const MODEL_FLASH = "gemini-3.5-flash";
export const MODEL_LITE = "gemini-3.1-flash-lite";
export const MODEL_LITE_CHEAP = "gemini-2.5-flash-lite";

const DEFAULT_MODEL = MODEL_LITE;

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
    /**
     * Stable kebab-case callsite identifier (e.g. `bullet-assist-fill`,
     * `posting-parse`). Required by LOP-2 — used as the run name in Lunary,
     * the Promptfoo eval suite key, and the future prompt-registry slug.
     * Canonical list lives in `docs/implementation.md` §LLM observability.
     */
    name: string;
    system?: string;
    user: string;
    schema: z.ZodSchema<T>;
    model?: string;
    temperature?: number;
    /**
     * Hard cap on output tokens for this call. Default 4096 — fine for the
     * vast majority of structured-extraction outputs (a few hundred tokens of
     * JSON). Bump explicitly per-call for prompts that legitimately need a
     * larger window (profile import with nested bullets is the canonical
     * case; see docs/llm-calls.md).
     */
    maxOutputTokens?: number;
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

// LOP-3: inner generate function — the actual Gemini SDK call. Wrapped below
// by lunary.wrapModel when LUNARY_ENABLED so every call is traced; bypassed
// entirely when the public key is unset.
interface GenerateArgs {
    name: string;
    model: string;
    system?: string;
    user: string;
    temperature: number;
    maxOutputTokens: number;
}

async function rawGenerate(args: GenerateArgs) {
    return getClient().models.generateContent({
        model: args.model,
        contents: args.user,
        config: {
            responseMimeType: "application/json",
            temperature: args.temperature,
            // Gemini 2.5 Flash defaults to thinking mode, which (a) adds
            // 30s–2min of latency to what should be sub-10s structured
            // extraction and (b) eats the output budget so JSON responses
            // get truncated mid-string. All current callers are mechanical
            // extraction/transformation — no chain-of-thought needed.
            thinkingConfig: { thinkingBudget: 0 },
            // Per-call cap. Defaults to 4096 — enough for typical structured
            // extraction. Profile import passes 32768 explicitly because nested
            // bullet arrays legitimately need it. Tightening this defends
            // against a runaway response burning the output budget and surfaces
            // a MAX_TOKENS error (caught below) instead of silently returning
            // truncated JSON.
            maxOutputTokens: args.maxOutputTokens,
            ...(args.system ? { systemInstruction: args.system } : {}),
        },
    });
}

const tracedGenerate = LUNARY_ENABLED
    ? lunary.wrapModel(rawGenerate, {
        nameParser: (args) => args.name,
        inputParser: (args) => {
            const messages: { role: "system" | "user"; content: string }[] = [];
            if (args.system) messages.push({ role: "system", content: args.system });
            messages.push({ role: "user", content: args.user });
            return messages;
        },
        paramsParser: (args) => ({
            model: args.model,
            temperature: args.temperature,
            maxOutputTokens: args.maxOutputTokens,
        }),
        outputParser: (res) => ({ role: "assistant", content: res?.text ?? "" }),
        tokensUsageParser: async (res) => ({
            prompt: res?.usageMetadata?.promptTokenCount ?? 0,
            completion: res?.usageMetadata?.candidatesTokenCount ?? 0,
        }),
    })
    : rawGenerate;

/**
 * Run a single-turn JSON-mode prompt against Gemini and validate the response
 * against the provided Zod schema. Returns the typed, validated result.
 *
 * Adding a real prompt? Route it through this helper, not the SDK directly —
 * one place to handle retries, env-var checks, token logging, and (LOP-3)
 * Lunary tracing. Pick a stable `name` per the inventory in
 * `docs/implementation.md` §LLM observability.
 */
export async function chatJSON<T>(opts: ChatJSONOptions<T>): Promise<T> {
    const model = opts.model ?? DEFAULT_MODEL;

    const response = await withRetry(async () => {
        // PC-6: block on the token bucket BEFORE each attempt — retries
        // shouldn't bypass the rate gate either. The bucket is process-shared
        // with lib/email-parser.ts so resume gen + classifier compete fairly
        // for the same Gemini free-tier quota.
        await acquireGeminiSlot();
        return tracedGenerate({
            name: opts.name,
            model,
            system: opts.system,
            user: opts.user,
            temperature: opts.temperature ?? 0.4,
            maxOutputTokens: opts.maxOutputTokens ?? 4096,
        });
    }).catch((err: unknown) => {
        throw new AIError(`Gemini request failed: ${err instanceof Error ? err.message : String(err)}`, err, "request");
    });

    const usage = response.usageMetadata;
    if (usage) {
        console.info(
            `[AI] ${opts.name} ${model} tokens: prompt=${usage.promptTokenCount ?? "?"} candidates=${usage.candidatesTokenCount ?? "?"} total=${usage.totalTokenCount ?? "?"}`,
        );
    }

    const text = response.text;
    const finishReason = response.candidates?.[0]?.finishReason;
    if (!text) {
        throw new AIError("Gemini returned an empty response", response, "parse");
    }
    // If the model ran out of output budget mid-stream the text will be a
    // half-finished JSON document — `JSON.parse` will throw a confusing
    // "Unterminated string". Surface the actual cause so the UI can tell the
    // user to retry / shrink the input instead of just showing a stack trace.
    if (finishReason === "MAX_TOKENS") {
        throw new AIError(
            "Gemini response was truncated (hit the output-token limit). The input is too large for a single call — try splitting it into smaller files.",
            response,
            "parse",
        );
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
