import { GoogleGenAI } from "@google/genai";
import lunary from "lunary";
import type { z } from "zod";
import { acquireGeminiSlot } from "@/lib/ai/rate-limit";
import { cacheKey, llmCached } from "@/lib/ai/llm-cache";

// LOP-3 + audit-bug #10: gate Lunary wrapping at CALL time, not module-init.
// Dev / test / CI runs without the public key are still a true no-op (no
// queueing, no event loop hits) — `tracedGenerate` short-circuits to
// `rawGenerate` whenever the env is empty. Reading at call time matches
// lib/ai/prompts.ts:lunaryEnabled, so ad-hoc tsx scripts that import this
// module before their env loader runs still pick up Lunary correctly once
// the env settles.
function lunaryEnabled(): boolean {
    return Boolean(process.env.LUNARY_PUBLIC_KEY);
}

// LOP-9: when set, dump every chatJSON call's rendered (system, user) pair to
// console.info as a single line: `[FIXTURE] {"name":..., "model":..., "system":..., "user":...}`.
// Read at call time so a `pm2 restart --update-env` flip takes effect without
// needing the import order to land before the env was set. Used to harvest
// real prompts to replace the synthetic seed entries in `eval/suites/*.yaml`.
// Workflow: `CAPTURE_FIXTURES=1 pm2 restart mission-control-dev --update-env`,
// use the app for ~30 min, then `pm2 logs mission-control-dev --raw --nostream --lines 5000 | grep '\[FIXTURE\]'`.
function captureFixturesEnabled(): boolean {
    return process.env.CAPTURE_FIXTURES === "1";
}

// Three-tier model fleet. See `docs/llm-calls.html` for the per-callsite
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
     * case; see docs/llm-calls.html).
     */
    maxOutputTokens?: number;
    /**
     * Cross-tier dedup (docs/cross-tier-llm-dedup.html). Default `true`: the
     * call is content-addressed (model + rendered prompt + schema) and shared
     * with the other tier via the SQLite store, so Gemini is hit once per
     * unique input. Set `false` for intentionally-generative callsites meant to
     * RE-ROLL on identical input (the "suggest / draft N things" calls) —
     * freezing those would be a regression. Deterministic extraction /
     * classification (the default) is safe and high-value to cache.
     */
    cache?: boolean;
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
// by lunary.wrapModel when lunaryEnabled() so every call is traced; bypassed
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
            // Disable thinking across the fleet. Full Flash (3.5, 2.5) defaults
            // thinking ON, which (a) adds 30s–2min of latency to what should be
            // sub-10s structured extraction and (b) eats the output budget so
            // JSON responses get truncated mid-string. Flash-lite variants
            // (3.1-flash-lite, 2.5-flash-lite) default thinking OFF, so the
            // budget=0 is a no-op for them — kept explicit so the guarantee
            // holds if a caller flips to full Flash. All current callers are
            // mechanical extraction/transformation — no chain-of-thought needed.
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

// Wrapper is built lazily on first traced call and memoized — we don't pay
// the wrapModel cost on processes that never enable Lunary, and we don't
// freeze the choice at import time. Subsequent calls re-use the cached
// wrapper. If LUNARY_PUBLIC_KEY toggles OFF mid-process, future calls bypass
// the wrapper via the `lunaryEnabled()` check below.
let _wrappedGenerate: typeof rawGenerate | null = null;
function getWrappedGenerate(): typeof rawGenerate {
    if (_wrappedGenerate) return _wrappedGenerate;
    _wrappedGenerate = lunary.wrapModel(rawGenerate, {
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
    });
    return _wrappedGenerate;
}

function tracedGenerate(args: Parameters<typeof rawGenerate>[0]): ReturnType<typeof rawGenerate> {
    return lunaryEnabled() ? getWrappedGenerate()(args) : rawGenerate(args);
}

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
    // Eval-only model override. When `MC_EVAL_DOWNGRADE_CALLSITES` lists this
    // call's `name` and `MC_EVAL_DOWNGRADE_MODEL` is set, swap the model — lets
    // the downgrade probe (`scripts/tests/probes/eval-downgrade-probe.ts`) A/B
    // candidate callsites against MODEL_LITE_CHEAP without touching handlers.
    // Both env vars are eval-only; prod never sets them.
    const downgradeCallsites = (process.env.MC_EVAL_DOWNGRADE_CALLSITES ?? "")
        .split(",").map(s => s.trim()).filter(Boolean);
    const downgradeModel = process.env.MC_EVAL_DOWNGRADE_MODEL;
    const model = (downgradeModel && downgradeCallsites.includes(opts.name))
        ? downgradeModel
        : (opts.model ?? DEFAULT_MODEL);

    if (captureFixturesEnabled()) {
        console.info("[FIXTURE]", JSON.stringify({
            name: opts.name,
            model,
            system: opts.system,
            user: opts.user,
        }));
    }

    // Resolve the per-call params ONCE so the cache key matches exactly what
    // the API call would receive.
    const temperature = opts.temperature ?? 0.4;
    const maxOutputTokens = opts.maxOutputTokens ?? 4096;

    // The real (rate-limited) model call + parse + validate. Runs only when WE
    // lead the reservation (or on the cache's best-effort fallback). The rate
    // slot lives INSIDE here so a cache hit / follower spends no token and
    // makes no API call. See docs/cross-tier-llm-dedup.html §5.
    const compute = async (): Promise<T> => {
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
                temperature,
                maxOutputTokens,
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
            const errMsg = err instanceof Error ? err.message : String(err);
            const posMatch = errMsg.match(/position (\d+)/);
            const pos = posMatch ? parseInt(posMatch[1], 10) : null;
            // For trailing-garbage / mid-string failures the relevant bytes are at
            // `pos`, not the head — log a window around it (with JSON.stringify so
            // newlines/control chars are visible) plus the tail length so we can
            // see whether the model double-emitted, fence-wrapped, etc.
            const window = pos != null
                ? `pos ${pos} window=${JSON.stringify(text.slice(Math.max(0, pos - 80), pos + 80))}`
                : `tail=${JSON.stringify(text.slice(-200))}`;
            throw new AIError(
                `Gemini response was not valid JSON [${errMsg}; total length=${text.length}]: head=${JSON.stringify(text.slice(0, 200))}; ${window}`,
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
    };

    // Opt-out: generative callsites (suggest / draft) re-roll on identical
    // input and must NOT be frozen. Everything else is content-addressed and
    // shared cross-tier. See docs/cross-tier-llm-dedup.html §6.
    if (opts.cache === false) return compute();

    const key = cacheKey({
        model,
        system: opts.system,
        user: opts.user,
        schema: opts.schema,
        temperature,
        maxOutputTokens,
    });
    return llmCached({ key, name: opts.name, model }, compute);
}
