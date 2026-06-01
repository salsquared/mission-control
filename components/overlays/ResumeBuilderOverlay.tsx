"use client";
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
    X,
    FileText,
    FileType2,
    Loader2,
    Save,
    Sparkles,
    Type,
    Layers,
    AlertTriangle,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/api-client";
import { toastStore } from "@/lib/toast-store";
import type { ProfileWire } from "@/lib/schemas/profile";
import type { CanonSelection } from "@/lib/schemas/canons";
import { SELECTION_SECTION_KEYS, type SelectionSectionKey } from "@/lib/schemas/canons";

// ─── Manual Resume Builder overlay (docs/archive/resume-manual-builder.html, P3.1) ──
// A Window-class floating overlay (portal to <body>) that lets the user
// hand-pick which profile entities + bullets + extras land on a single Canon's
// reusable resume, then Save the selection and/or Generate a PDF/DOCX. Binary
// checkboxes only — no lock / 3-state (OQ5). Section types toggle entirely off.

type Format = "pdf" | "docx";

interface ResumeBuilderOverlayProps {
    canon: { id: string; name: string; currentResumeId: string | null };
    onClose: () => void;
}

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// Human-readable labels for the resumes route's internal `stage` values
// (mirrors GenerateResumeCard's map — keep in sync with app/api/resumes/route.ts).
const STAGE_LABELS = {
    input: "Bad input",
    load: "Loading your profile",
    parse: "Reading the posting",
    select: "Picking bullets",
    rewrite: "Rewriting bullets via AI",
    render: "Rendering the file",
} as const;

const FORMAT_STORAGE_KEY = "mc-resume-format";

// Section types in fixed default order (OQ8 — user reordering deferred). The
// entity sections (experience/projects/education) drive the entity tree; the
// extras sections (skills/languages/interests) drive the item pickers.
const ENTITY_SECTIONS: Array<{
    key: Extract<SelectionSectionKey, "experience" | "projects" | "education">;
    label: string;
    kind: "workRole" | "project" | "education";
}> = [
    { key: "experience", label: "Experience", kind: "workRole" },
    { key: "projects", label: "Projects", kind: "project" },
    { key: "education", label: "Education", kind: "education" },
];

// ─── Editable in-memory state ───────────────────────────────────────────────
// `entities`: present key ⇒ included; value is the Set of checked bullet ids.
// `extras`: a Set of checked item strings / language names / hobby strings.
interface EntityState {
    kind: "workRole" | "project" | "education";
    bulletIds: Set<string>;
}

interface BuilderState {
    entities: Map<string, EntityState>;
    skillItems: Set<string>;
    languages: Set<string>;
    hobbies: Set<string>;
    sectionsOff: Set<SelectionSectionKey>;
}

// A stored resume's `selections` rows (api.resumes.get → `selections` is
// z.unknown()). We only read kind + sourceId + bulletId for the P3.3 pre-fill.
interface StoredSelectionRow {
    kind?: string;
    sourceId?: string;
    bulletId?: string;
}

function emptyState(): BuilderState {
    return {
        entities: new Map(),
        skillItems: new Set(),
        languages: new Set(),
        hobbies: new Set(),
        sectionsOff: new Set(),
    };
}

// Build the initial editable state from (in priority order): a saved
// CanonSelection, else the canon's last rendered resume (P3.3 pre-fill), else
// empty for entities. Extras default to ALL profile items checked when there's
// no saved selection.
function buildInitialState(
    profile: ProfileWire,
    saved: CanonSelection | null,
    priorResumeRows: StoredSelectionRow[] | null,
): BuilderState {
    const state = emptyState();
    const allSkillItems = (profile.skills ?? []).flatMap((g) => g.items);
    const allLanguages = (profile.languages ?? []).map((l) => l.name);
    const allHobbies = profile.hobbies ?? [];

    if (saved) {
        // 1) A previously-saved manual selection wins — load it verbatim.
        for (const [entityId, entry] of Object.entries(saved.entities)) {
            state.entities.set(entityId, { kind: entry.kind, bulletIds: new Set(entry.bulletIds) });
        }
        state.skillItems = new Set(saved.extras.skillItems);
        state.languages = new Set(saved.extras.languages);
        state.hobbies = new Set(saved.extras.hobbies);
        state.sectionsOff = new Set(saved.sectionsOff);
        return state;
    }

    if (priorResumeRows && priorResumeRows.length > 0) {
        // 2) No saved selection but the canon has a last-rendered resume —
        //    pre-fill from its `selections` rows, grouped by sourceId (P3.3).
        for (const row of priorResumeRows) {
            const kind = row.kind;
            const sourceId = row.sourceId;
            const bulletId = row.bulletId;
            if (!sourceId || (kind !== "workRole" && kind !== "project" && kind !== "education")) continue;
            let ent = state.entities.get(sourceId);
            if (!ent) {
                ent = { kind, bulletIds: new Set() };
                state.entities.set(sourceId, ent);
            }
            if (bulletId) ent.bulletIds.add(bulletId);
        }
        // Extras default all-checked.
        state.skillItems = new Set(allSkillItems);
        state.languages = new Set(allLanguages);
        state.hobbies = new Set(allHobbies);
        return state;
    }

    // 3) Brand-new canon, no resume → empty entities; extras default all-checked.
    state.skillItems = new Set(allSkillItems);
    state.languages = new Set(allLanguages);
    state.hobbies = new Set(allHobbies);
    return state;
}

// ─── Page-count heuristic (OQ14 = A — fast in-browser estimate) ─────────────
// APPROXIMATE only. A rough lines-per-page model: each included entity costs a
// header (~2 lines) + each checked bullet (~1.5 lines, accounting for wrap),
// plus the extras section lines. Divided by ~48 lines per US-Letter page. This
// is intentionally crude — the EXACT count comes back in the X-Resume-Pages
// header at Generate. Tune the constants if the estimate drifts from reality.
const LINES_PER_PAGE = 48;
const LINES_PER_ENTITY_HEADER = 2;
const LINES_PER_BULLET = 1.5;
const LINES_HEADER_BLOCK = 6; // name / contact / tagline block at the top

function estimatePages(state: BuilderState): number {
    let lines = LINES_HEADER_BLOCK;
    for (const ent of state.entities.values()) {
        lines += LINES_PER_ENTITY_HEADER;
        lines += ent.bulletIds.size * LINES_PER_BULLET;
    }
    // Extras: each non-off, non-empty section is roughly a label line + a
    // wrapped item line per ~6 items.
    if (!state.sectionsOff.has("skills") && state.skillItems.size > 0) {
        lines += 1 + Math.ceil(state.skillItems.size / 6);
    }
    if (!state.sectionsOff.has("languages") && state.languages.size > 0) {
        lines += 1 + Math.ceil(state.languages.size / 6);
    }
    if (!state.sectionsOff.has("interests") && state.hobbies.size > 0) {
        lines += 1 + Math.ceil(state.hobbies.size / 6);
    }
    return Math.max(1, Math.ceil(lines / LINES_PER_PAGE));
}

// Serialize the editable state into the CanonSelection PUT payload. `excluded`
// (OQ5=B) = every profile entity present-but-unchecked at save — the
// "reviewed and left out" snapshot.
function buildSelection(profile: ProfileWire, state: BuilderState): CanonSelection {
    const entities: CanonSelection["entities"] = {};
    for (const [id, ent] of state.entities) {
        entities[id] = { kind: ent.kind, bulletIds: [...ent.bulletIds] };
    }
    const allEntityIds = [
        ...profile.workRoles.map((w) => w.id),
        ...profile.projects.map((p) => p.id),
        ...profile.education.map((e) => e.id),
    ];
    const excluded = allEntityIds.filter((id) => !state.entities.has(id));
    return {
        version: 1,
        sectionOrder: [...SELECTION_SECTION_KEYS],
        sectionsOff: [...state.sectionsOff],
        entities,
        excluded,
        extras: {
            skillItems: [...state.skillItems],
            languages: [...state.languages],
            hobbies: [...state.hobbies],
        },
    };
}

export function ResumeBuilderOverlay(props: ResumeBuilderOverlayProps): React.JSX.Element {
    const { canon, onClose } = props;
    const queryClient = useQueryClient();

    // SSR gate: createPortal needs document.body.
    const [mounted, setMounted] = useState(false);
    useEffect(() => { setMounted(true); }, []);

    const profileQuery = useQuery({
        queryKey: queryKeys.profile,
        queryFn: () => api.profile.get(),
    });
    const selectionQuery = useQuery({
        queryKey: queryKeys.canonSelection(canon.id),
        queryFn: () => api.canons.getSelection(canon.id),
    });

    // P3.3 — only fetch the prior resume when there's no saved selection AND the
    // canon has a last-rendered resume to pre-fill from.
    const savedSelection = selectionQuery.data?.selection ?? null;
    const needsPriorResume =
        selectionQuery.isSuccess && savedSelection === null && !!canon.currentResumeId;
    const priorResumeQuery = useQuery({
        queryKey: queryKeys.resume(canon.currentResumeId ?? ""),
        queryFn: () => api.resumes.get(canon.currentResumeId!),
        enabled: needsPriorResume,
    });

    const profile = profileQuery.data?.profile ?? null;

    // ─── Editable state ──────────────────────────────────────────────────────
    const [state, setState] = useState<BuilderState | null>(null);
    const [seeded, setSeeded] = useState(false);
    const [format, setFormat] = useState<Format>(() => {
        try {
            const saved = window.localStorage.getItem(FORMAT_STORAGE_KEY);
            if (saved === "pdf" || saved === "docx") return saved;
        } catch { /* localStorage unavailable */ }
        return "pdf";
    });
    const [rewrite, setRewrite] = useState(false);
    const [tagline, setTagline] = useState(false);
    const [busy, setBusy] = useState(false);
    const [stage, setStage] = useState<string | null>(null);
    const [exactPages, setExactPages] = useState<number | null>(null);
    const [dirty, setDirty] = useState(false);

    // Seed editable state once every input query has settled. We gate on
    // `seeded` so live re-renders (and the user's edits) don't trample it.
    const priorReady = !needsPriorResume || priorResumeQuery.isSuccess || priorResumeQuery.isError;
    useEffect(() => {
        if (seeded || !profile || !selectionQuery.isSuccess || !priorReady) return;
        const priorRows = needsPriorResume
            ? ((priorResumeQuery.data?.resume.selections as StoredSelectionRow[] | undefined) ?? [])
            : null;
        setState(buildInitialState(profile, savedSelection, priorRows));
        setSeeded(true);
    }, [
        seeded, profile, selectionQuery.isSuccess, priorReady, needsPriorResume,
        priorResumeQuery.data, savedSelection,
    ]);

    // ─── Mutators ────────────────────────────────────────────────────────────
    const mutate = useCallback((fn: (s: BuilderState) => BuilderState) => {
        setState((prev) => (prev ? fn(prev) : prev));
        setDirty(true);
    }, []);

    const toggleEntity = useCallback((id: string, kind: "workRole" | "project" | "education", bulletIds: string[]) => {
        mutate((s) => {
            const entities = new Map(s.entities);
            if (entities.has(id)) {
                entities.delete(id);
            } else {
                // Default: all bullets checked when an entity is first included.
                entities.set(id, { kind, bulletIds: new Set(bulletIds) });
            }
            return { ...s, entities };
        });
    }, [mutate]);

    const toggleBullet = useCallback((entityId: string, bulletId: string) => {
        mutate((s) => {
            const entities = new Map(s.entities);
            const ent = entities.get(entityId);
            if (!ent) return s;
            const bulletIds = new Set(ent.bulletIds);
            if (bulletIds.has(bulletId)) bulletIds.delete(bulletId);
            else bulletIds.add(bulletId);
            entities.set(entityId, { ...ent, bulletIds });
            return { ...s, entities };
        });
    }, [mutate]);

    const toggleSet = useCallback((field: "skillItems" | "languages" | "hobbies", value: string) => {
        mutate((s) => {
            const next = new Set(s[field]);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            return { ...s, [field]: next };
        });
    }, [mutate]);

    const toggleSectionOff = useCallback((key: SelectionSectionKey) => {
        mutate((s) => {
            const sectionsOff = new Set(s.sectionsOff);
            if (sectionsOff.has(key)) sectionsOff.delete(key);
            else sectionsOff.add(key);
            return { ...s, sectionsOff };
        });
    }, [mutate]);

    function pickFormat(f: Format) {
        setFormat(f);
        try { window.localStorage.setItem(FORMAT_STORAGE_KEY, f); } catch { /* noop */ }
    }

    const estPages = useMemo(() => (state ? estimatePages(state) : 1), [state]);

    // ─── Save / Generate ─────────────────────────────────────────────────────
    async function doSave(): Promise<boolean> {
        if (!profile || !state) return false;
        const selection = buildSelection(profile, state);
        await api.canons.saveSelection(canon.id, selection);
        setDirty(false);
        await queryClient.invalidateQueries({ queryKey: queryKeys.canonSelection(canon.id) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.canons() });
        return true;
    }

    async function handleSave() {
        if (busy || !profile || !state) return;
        setBusy(true);
        setStage("Saving…");
        try {
            await doSave();
            toastStore.push({ message: "Resume selection saved", type: "info" });
        } catch (e) {
            toastStore.push({ message: `Save failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusy(false);
            setStage(null);
        }
    }

    async function handleGenerate() {
        if (busy || !profile || !state) return;
        setBusy(true);
        setExactPages(null);
        try {
            // Save first so the server reads the latest Canon.selection.
            setStage("Saving…");
            await doSave();

            setStage("Generating…");
            const res = await fetch("/api/resumes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    posting: { canonId: canon.id },
                    options: { format, rewrite, tagline },
                }),
            });
            if (!res.ok) {
                let detail = "";
                let stageLabel = "";
                try {
                    const j = await res.json();
                    detail = j.error ? (typeof j.error === "string" ? j.error : JSON.stringify(j.error)) : "";
                    stageLabel = STAGE_LABELS[j.stage as keyof typeof STAGE_LABELS] ?? "";
                } catch { /* non-JSON */ }
                const composed = stageLabel ? `${stageLabel}: ${detail}` : detail || `HTTP ${res.status}`;
                throw new Error(composed);
            }
            const blob = await res.blob();
            const responseFormat = (res.headers.get("X-Resume-Format") as Format | null) ?? format;
            const pagesHeader = res.headers.get("X-Resume-Pages");
            const pages = pagesHeader ? parseInt(pagesHeader, 10) : NaN;
            if (Number.isFinite(pages)) setExactPages(pages);
            const filename = (() => {
                const cd = res.headers.get("Content-Disposition") ?? "";
                const m = cd.match(/filename="([^"]+)"/);
                return m?.[1] ?? `resume.${responseFormat}`;
            })();
            if (responseFormat === "pdf") {
                // Open an HTML preview (links open in their own tab and never
                // close the resume) instead of the raw PDF blob — Chrome's PDF
                // viewer ignores target=_blank on PDF link annotations. The PDF
                // artifact is persisted and downloadable from the Generated
                // Resumes list; the selection was just saved above, so the
                // preview matches what was generated. Pass the exact page count
                // from the PDF render (X-Resume-Pages) so the preview shows an
                // authoritative page-fit banner, not the line-count estimate.
                const previewUrl = `/api/canons/${canon.id}/preview${Number.isFinite(pages) ? `?pages=${pages}` : ""}`;
                window.open(previewUrl, "_blank");
            } else {
                const objectUrl = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = objectUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
            const pageNote = Number.isFinite(pages) ? ` — ${pages} page${pages === 1 ? "" : "s"}` : "";
            toastStore.push({ message: `Resume generated (${responseFormat.toUpperCase()})${pageNote}`, type: "info" });
        } catch (e) {
            toastStore.push({ message: `Generate failed: ${errMessage(e)}`, type: "error" });
        } finally {
            setBusy(false);
            setStage(null);
        }
    }

    const handleClose = useCallback(() => {
        if (busy) return;
        if (dirty && !window.confirm("Discard unsaved changes to this resume selection?")) return;
        onClose();
    }, [busy, dirty, onClose]);

    if (!mounted) return <></>;

    const loading = profileQuery.isLoading || selectionQuery.isLoading || (needsPriorResume && priorResumeQuery.isLoading) || !state;
    const loadError = profileQuery.error || selectionQuery.error;

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={handleClose}
        >
            <div
                className="w-full max-w-3xl rounded-2xl border border-purple-400/20 bg-neutral-950 shadow-2xl flex flex-col max-h-[88vh]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* ─── Header ─────────────────────────────────────────────── */}
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-purple-300 shrink-0" />
                        <h2 className="text-sm font-semibold text-white truncate">
                            Resume builder — <span className="text-purple-200">{canon.name}</span>
                        </h2>
                    </div>
                    <button
                        onClick={handleClose}
                        className="text-white/40 hover:text-white/80 transition-colors shrink-0"
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* ─── Body ───────────────────────────────────────────────── */}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
                    {loading ? (
                        <div className="flex items-center justify-center gap-2 py-16 text-sm text-white/50">
                            <Loader2 className="w-4 h-4 animate-spin" /> Loading your profile…
                        </div>
                    ) : loadError ? (
                        <div className="px-3 py-4 rounded-lg bg-rose-500/10 border border-rose-400/30 text-[11px] text-rose-200">
                            Failed to load: {errMessage(loadError)}
                        </div>
                    ) : profile && state ? (
                        <div className="flex flex-col gap-6">
                            <p className="text-xs text-white/50">
                                Hand-pick exactly what goes on this canon&apos;s resume. Checked entities and bullets are
                                included verbatim; an unchecked item is structurally absent — nothing is auto-decided.
                            </p>

                            {/* Entity sections */}
                            {ENTITY_SECTIONS.map(({ key, label, kind }) => {
                                const off = state.sectionsOff.has(key);
                                const entities =
                                    kind === "workRole" ? profile.workRoles :
                                    kind === "project" ? profile.projects :
                                    profile.education;
                                return (
                                    <SectionBlock
                                        key={key}
                                        label={label}
                                        sectionKey={key}
                                        off={off}
                                        onToggleOff={() => toggleSectionOff(key)}
                                        disabled={busy}
                                    >
                                        {entities.length === 0 ? (
                                            <div className="text-[11px] text-white/30 italic px-1 py-1">
                                                No {label.toLowerCase()} in your profile yet.
                                            </div>
                                        ) : (
                                            <div className="flex flex-col gap-1">
                                                {entities.map((e) => {
                                                    const ent = state.entities.get(e.id);
                                                    const checked = !!ent;
                                                    const entLabel =
                                                        kind === "workRole" ? `${(e as ProfileWire["workRoles"][number]).title} @ ${(e as ProfileWire["workRoles"][number]).company}` :
                                                        kind === "project" ? (e as ProfileWire["projects"][number]).name :
                                                        `${(e as ProfileWire["education"][number]).degree ?? ""} ${(e as ProfileWire["education"][number]).institution}`.trim();
                                                    const allBulletIds = e.bullets.map((b) => b.id);
                                                    return (
                                                        <div key={e.id}>
                                                            <CheckRow
                                                                label={entLabel || "(untitled)"}
                                                                checked={checked}
                                                                onToggle={() => toggleEntity(e.id, kind, allBulletIds)}
                                                                disabled={busy || off}
                                                                strong
                                                            />
                                                            {checked && e.bullets.length > 0 && (
                                                                <div className="ml-6 mt-1 mb-1 flex flex-col gap-1 border-l border-white/10 pl-3">
                                                                    {e.bullets.map((b) => (
                                                                        <CheckRow
                                                                            key={b.id}
                                                                            label={b.text}
                                                                            checked={ent!.bulletIds.has(b.id)}
                                                                            onToggle={() => toggleBullet(e.id, b.id)}
                                                                            disabled={busy || off}
                                                                            small
                                                                        />
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </SectionBlock>
                                );
                            })}

                            {/* Skills */}
                            <SectionBlock
                                label="Skills"
                                sectionKey="skills"
                                off={state.sectionsOff.has("skills")}
                                onToggleOff={() => toggleSectionOff("skills")}
                                disabled={busy}
                            >
                                {(profile.skills ?? []).length === 0 ? (
                                    <div className="text-[11px] text-white/30 italic px-1 py-1">No skills in your profile yet.</div>
                                ) : (
                                    <div className="flex flex-col gap-3">
                                        {(profile.skills ?? []).map((g) => (
                                            <div key={g.category}>
                                                <div className="text-[10px] uppercase tracking-wide text-white/40 mb-1">{g.category}</div>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {g.items.map((item) => (
                                                        <Chip
                                                            key={item}
                                                            label={item}
                                                            checked={state.skillItems.has(item)}
                                                            onToggle={() => toggleSet("skillItems", item)}
                                                            disabled={busy || state.sectionsOff.has("skills")}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </SectionBlock>

                            {/* Languages */}
                            <SectionBlock
                                label="Languages"
                                sectionKey="languages"
                                off={state.sectionsOff.has("languages")}
                                onToggleOff={() => toggleSectionOff("languages")}
                                disabled={busy}
                            >
                                {(profile.languages ?? []).length === 0 ? (
                                    <div className="text-[11px] text-white/30 italic px-1 py-1">No languages in your profile yet.</div>
                                ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                        {(profile.languages ?? []).map((l) => (
                                            <Chip
                                                key={l.name}
                                                label={`${l.name} · ${l.proficiency}`}
                                                checked={state.languages.has(l.name)}
                                                onToggle={() => toggleSet("languages", l.name)}
                                                disabled={busy || state.sectionsOff.has("languages")}
                                            />
                                        ))}
                                    </div>
                                )}
                            </SectionBlock>

                            {/* Interests */}
                            <SectionBlock
                                label="Interests"
                                sectionKey="interests"
                                off={state.sectionsOff.has("interests")}
                                onToggleOff={() => toggleSectionOff("interests")}
                                disabled={busy}
                            >
                                {(profile.hobbies ?? []).length === 0 ? (
                                    <div className="text-[11px] text-white/30 italic px-1 py-1">No interests in your profile yet.</div>
                                ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                        {(profile.hobbies ?? []).map((h) => (
                                            <Chip
                                                key={h}
                                                label={h}
                                                checked={state.hobbies.has(h)}
                                                onToggle={() => toggleSet("hobbies", h)}
                                                disabled={busy || state.sectionsOff.has("interests")}
                                            />
                                        ))}
                                    </div>
                                )}
                            </SectionBlock>
                        </div>
                    ) : null}
                </div>

                {/* ─── Footer (controls + actions) ────────────────────────── */}
                {!loading && profile && state && (
                    <div className="shrink-0 border-t border-white/10 px-4 py-3 flex flex-col gap-3">
                        <div className="flex items-center gap-3 flex-wrap">
                            {/* Format toggle */}
                            <div className="inline-flex rounded-lg overflow-hidden border border-white/10 bg-black/40" role="group" aria-label="Output format">
                                {(["pdf", "docx"] as const).map((f) => (
                                    <button
                                        key={f}
                                        type="button"
                                        onClick={() => pickFormat(f)}
                                        disabled={busy}
                                        aria-pressed={format === f}
                                        className={[
                                            "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center gap-1.5",
                                            format === f ? "bg-purple-500/30 text-purple-100" : "text-white/50 hover:text-white/80",
                                            busy ? "opacity-40 cursor-not-allowed" : "",
                                        ].join(" ")}
                                    >
                                        {f === "pdf" ? <FileText className="w-3 h-3" /> : <FileType2 className="w-3 h-3" />}
                                        {f}
                                    </button>
                                ))}
                            </div>

                            {/* AI rewrite toggle */}
                            <ToggleChip
                                active={rewrite}
                                onClick={() => setRewrite((v) => !v)}
                                disabled={busy}
                                icon={Sparkles}
                                label="AI rewrite"
                                title="When on, AI re-words the bullets that match this canon's keywords to emphasize what the role cares about. Off → bullets render exactly as written."
                            />

                            {/* AI tagline toggle */}
                            <ToggleChip
                                active={tagline}
                                onClick={() => setTagline((v) => !v)}
                                disabled={busy}
                                icon={Type}
                                label="AI tagline"
                                title="When on, AI writes a tailored one-line subtitle for the resume from this canon's keywords. Off → uses your profile tagline verbatim."
                            />

                            {/* Live page estimate (approximate — exact comes from Generate) */}
                            <div
                                className={[
                                    "ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold",
                                    estPages > 1
                                        ? "bg-amber-500/10 text-amber-200 border-amber-400/30"
                                        : "bg-white/[0.03] text-white/60 border-white/10",
                                ].join(" ")}
                                title="Fast in-browser estimate — the exact page count is confirmed when you Generate."
                            >
                                {estPages > 1 ? <AlertTriangle className="w-3 h-3" /> : <Layers className="w-3 h-3" />}
                                ~{estPages} page{estPages === 1 ? "" : "s"} (est.)
                                {exactPages !== null && (
                                    <span className="text-white/40 font-normal">
                                        · {exactPages} exact
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-2 justify-end">
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={busy}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-xs font-semibold text-white/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                {busy && stage === "Saving…" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                                Save
                            </button>
                            <button
                                type="button"
                                onClick={handleGenerate}
                                disabled={busy}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-400/30 text-xs font-semibold text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                                {busy ? (stage ?? "Working…") : `Save & Generate ${format.toUpperCase()}`}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}

// ─── Section block: header with on/off toggle + dimmed body when off ────────
const SectionBlock: React.FC<{
    label: string;
    sectionKey: SelectionSectionKey;
    off: boolean;
    onToggleOff: () => void;
    disabled: boolean;
    children: React.ReactNode;
}> = ({ label, off, onToggleOff, disabled, children }) => (
    <div>
        <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-purple-300/80">{label}</h3>
            <button
                type="button"
                onClick={onToggleOff}
                disabled={disabled}
                aria-pressed={!off}
                title={off ? "Section is off — toggle to include it" : "Toggle the whole section off"}
                className={[
                    "px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border transition-colors",
                    off
                        ? "bg-black/40 text-white/40 border-white/10 hover:text-white/70"
                        : "bg-purple-500/20 text-purple-100 border-purple-400/40",
                    disabled ? "opacity-40 cursor-not-allowed" : "",
                ].join(" ")}
            >
                {off ? "Off" : "On"}
            </button>
        </div>
        <div className={off ? "opacity-40 pointer-events-none select-none" : ""}>{children}</div>
    </div>
);

// ─── Checkbox row (entity = strong, bullet = small) ─────────────────────────
const CheckRow: React.FC<{
    label: string;
    checked: boolean;
    onToggle: () => void;
    disabled: boolean;
    strong?: boolean;
    small?: boolean;
}> = ({ label, checked, onToggle, disabled, strong, small }) => (
    <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={checked}
        className={[
            "w-full text-left flex items-start gap-2 px-2 py-1 rounded-lg transition-colors",
            disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-white/[0.03] cursor-pointer",
        ].join(" ")}
    >
        <span
            aria-hidden
            className={[
                "mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors",
                checked ? "bg-purple-500/50 border-purple-300" : "bg-black/40 border-white/20",
            ].join(" ")}
        >
            {checked && <CheckMark />}
        </span>
        <span
            className={[
                small ? "text-[11px]" : "text-xs",
                strong ? "font-semibold text-white/90" : "text-white/70",
                checked ? "" : "text-white/50",
            ].join(" ")}
        >
            {label}
        </span>
    </button>
);

// ─── Chip checkbox (extras) ─────────────────────────────────────────────────
const Chip: React.FC<{
    label: string;
    checked: boolean;
    onToggle: () => void;
    disabled: boolean;
}> = ({ label, checked, onToggle, disabled }) => (
    <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={checked}
        className={[
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
            checked
                ? "bg-purple-500/25 text-purple-100 border-purple-400/40"
                : "bg-black/40 text-white/50 border-white/10 hover:text-white/80",
            disabled ? "opacity-40 cursor-not-allowed" : "",
        ].join(" ")}
    >
        <span
            aria-hidden
            className={[
                "w-3 h-3 rounded border flex items-center justify-center shrink-0",
                checked ? "bg-purple-500/50 border-purple-300" : "bg-black/40 border-white/20",
            ].join(" ")}
        >
            {checked && <CheckMark small />}
        </span>
        {label}
    </button>
);

// ─── Footer toggle chip (AI rewrite / tagline) ──────────────────────────────
const ToggleChip: React.FC<{
    active: boolean;
    onClick: () => void;
    disabled: boolean;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    title: string;
}> = ({ active, onClick, disabled, icon: Icon, label, title }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        title={title}
        className={[
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-semibold uppercase tracking-wide transition-colors",
            active
                ? "bg-purple-500/30 text-purple-100 border-purple-400/40"
                : "bg-black/40 text-white/50 hover:text-white/80 border-white/10",
            disabled ? "opacity-40 cursor-not-allowed" : "",
        ].join(" ")}
    >
        <Icon className="w-3 h-3" />
        {label}
    </button>
);

// Small inline check glyph (avoids importing lucide Check twice).
const CheckMark: React.FC<{ small?: boolean }> = ({ small }) => (
    <svg
        className={small ? "w-2 h-2 text-purple-50" : "w-2.5 h-2.5 text-purple-50"}
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
    </svg>
);
