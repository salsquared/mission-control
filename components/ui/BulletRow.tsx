import React, { useState } from "react";
import { Lock, LockOpen, EyeOff, Eye, Trash2, Plus, X, Sparkles, Pin, Tags } from "lucide-react";
import type { Bullet } from "@/lib/profile/types";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface BulletRowProps {
    bullet: Bullet;
    onChange: (next: Bullet) => void;
    onDelete: () => void;
    /** Set when the bullet lives inside a Profile entry. When null, the
     *  rewrite + tag-suggest affordances are hidden (no parent context = no
     *  way to call the LLM). Locked bullets ALSO hide the wand + tags icon
     *  regardless. */
    rewriteContext?: {
        parentKind: 'work-role' | 'project' | 'education';
        parentId: string;
    } | null;
}

const TAG_MAX_LENGTH = 30;
// M7.7.5 — hard cap on tags per bullet. UI hides the tag-suggest icon at the
// cap so the user gets an immediate visual signal rather than a 400 after
// clicking. Server enforces the same cap as defense-in-depth.
const TAG_CAP = 7;

export const BulletRow: React.FC<BulletRowProps> = ({ bullet, onChange, onDelete, rewriteContext = null }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(bullet.text);
    const [addingTag, setAddingTag] = useState(false);
    const [tagDraft, setTagDraft] = useState("");
    // M7.6.9 — rewrite/diff state. proposal is the LLM-suggested text shown
    // in the diff panel; cleared on Accept or Discard. M7.7.2 narrowed this
    // to text-only — proposal.tags === bullet.tags always (server preserves).
    const [proposal, setProposal] = useState<Bullet | null>(null);
    const [rewriting, setRewriting] = useState(false);
    const [rewriteError, setRewriteError] = useState<string | null>(null);
    // M7.7.7 — tag-suggest diff state. Separate from rewrite so a user can
    // (theoretically) have both panels open — though the UI hides both
    // trigger buttons when either is pending to prevent stacking.
    const [tagProposal, setTagProposal] = useState<{ tags: string[]; reason?: string } | null>(null);
    const [suggestingTags, setSuggestingTags] = useState(false);
    const [tagSuggestError, setTagSuggestError] = useState<string | null>(null);

    const commit = () => {
        const trimmed = draft.trim();
        setEditing(false);
        if (trimmed && trimmed !== bullet.text) {
            onChange({ ...bullet, text: trimmed });
        } else if (!trimmed) {
            setDraft(bullet.text);
        }
    };

    const startEdit = () => {
        setDraft(bullet.text);
        setEditing(true);
    };

    // M8.5.6 Decision 6.1 + M7.7.1 invariant — removing a tag also clears its
    // pin (a pinned tag's deletion implicitly unpins) and adds the tag to
    // `removedTags` (blocklist). Same semantic regardless of whether the tag
    // was user-set, auto-added, or pinned.
    const removeTag = (t: string) => {
        onChange({
            ...bullet,
            tags: bullet.tags.filter(x => x !== t),
            autoTags: bullet.autoTags.filter(x => x !== t),
            pinnedTags: bullet.pinnedTags.filter(x => x !== t),
            removedTags: Array.from(new Set([...bullet.removedTags, t])),
        });
    };

    // M7.7.6 — pin toggle. Pinned tags survive the per-bullet AI tag
    // generator (M7.7.3) and the bulk auto-tag pass (M8.5). Pin is per-tag,
    // toggleable. Pinning a tag that's also in autoTags is fine (auto +
    // pinned = "auto-suggested but locked in").
    const togglePin = (t: string) => {
        const isPinned = bullet.pinnedTags.includes(t);
        onChange({
            ...bullet,
            pinnedTags: isPinned
                ? bullet.pinnedTags.filter(x => x !== t)
                : Array.from(new Set([...bullet.pinnedTags, t])),
        });
    };

    // Re-adding a tag (user-typed or otherwise) takes it OUT of removedTags
    // so the user's explicit positive action overrides any earlier removal.
    const commitTag = () => {
        const t = tagDraft.trim().toLowerCase().slice(0, TAG_MAX_LENGTH);
        setAddingTag(false);
        setTagDraft("");
        if (!t) return;
        if (bullet.tags.includes(t)) return;
        onChange({
            ...bullet,
            tags: Array.from(new Set([...bullet.tags, t])),
            removedTags: bullet.removedTags.filter(x => x !== t),
        });
    };

    // Lock/exclude buttons stay persistently visible when active so the
    // state is discoverable without hovering — M8-2.5 story S8.3 fix.
    const lockBtnAlwaysVisible = bullet.locked;
    const excludeBtnAlwaysVisible = bullet.excluded;

    // M7.6.9 + M7.7.6 — affordance visibility.
    //   * Wand (rewrite, text-only post-M7.7.2): hidden when locked, when
    //     no parent context, or while either proposal is pending.
    //   * Tags icon (M7.7.3 tag-suggest): same gates PLUS hidden when the
    //     bullet is already at the TAG_CAP (M7.7.5 — server would 400).
    const anyProposalPending = proposal != null || tagProposal != null;
    const llmGated = bullet.locked || rewriteContext == null || anyProposalPending;
    const wandVisible = !llmGated;
    const tagsButtonVisible = !llmGated && bullet.tags.length < TAG_CAP;

    const handleRewrite = async () => {
        if (!rewriteContext) return;
        setRewriting(true);
        setRewriteError(null);
        try {
            const result = await api.profile.bullets.assistRewrite(
                rewriteContext.parentKind,
                rewriteContext.parentId,
                bullet.id,
            );
            if (result.mode !== 'rewrite') throw new Error('unexpected response shape');
            setProposal(result.proposal);
        } catch (err) {
            setRewriteError(err instanceof Error ? err.message : 'Rewrite failed');
        } finally {
            setRewriting(false);
        }
    };

    const handleSuggestTags = async () => {
        if (!rewriteContext) return;
        setSuggestingTags(true);
        setTagSuggestError(null);
        try {
            const result = await api.profile.bullets.assistTags(
                rewriteContext.parentKind,
                rewriteContext.parentId,
                bullet.id,
            );
            if (result.mode !== 'tags') throw new Error('unexpected response shape');
            setTagProposal(result.proposal);
        } catch (err) {
            // M7.7.5 — surface the cap-reached case with a hint about the
            // remedy. Other errors get raw passthrough.
            const msg = err instanceof Error ? err.message : 'Tag suggestion failed';
            if (msg.includes('tag-limit-reached')) {
                setTagSuggestError('Tag limit reached — remove or unpin a tag first.');
            } else {
                setTagSuggestError(msg);
            }
        } finally {
            setSuggestingTags(false);
        }
    };

    const acceptProposal = () => {
        if (!proposal) return;
        // M7.7.2 — text-only acceptance. Tags / autoTags / removedTags /
        // pinnedTags pass through unchanged (the server already preserved them
        // in the proposal, but apply the original bullet's state defensively
        // in case the response was tampered with). `locked`/`excluded`
        // similarly preserved.
        onChange({ ...bullet, text: proposal.text });
        setProposal(null);
    };

    const discardProposal = () => {
        setProposal(null);
    };

    const acceptTagProposal = () => {
        if (!tagProposal) return;
        // M7.7.7 — apply the proposed tag list. Tags newly introduced by the
        // proposal (in proposal.tags but not in current bullet.tags) get
        // marked into autoTags so the UI badges them as pending user
        // confirmation (Decision 6.3 — same semantic as M8.5.6).
        // Pinned tags ride along unchanged — the server post-filter
        // guarantees they're in proposal.tags, so they stay applied.
        // Dropped tags do NOT add to removedTags — the user is implicitly
        // accepting the LLM's slimmer list, not blocking the dropped tags
        // from ever returning. Explicit chip-X click is still the only path
        // into the blocklist.
        const originalSet = new Set(bullet.tags);
        const newlyAdded = tagProposal.tags.filter(t => !originalSet.has(t));
        onChange({
            ...bullet,
            tags: tagProposal.tags,
            autoTags: Array.from(new Set([...bullet.autoTags, ...newlyAdded])),
        });
        setTagProposal(null);
    };

    const discardTagProposal = () => {
        setTagProposal(null);
    };

    return (
        <div className={cn(
            "group flex flex-col gap-1 px-2 py-1.5 rounded-md border transition-colors",
            bullet.locked
                ? "border-amber-500/30 bg-amber-500/[0.04] hover:border-amber-500/50"
                : bullet.excluded
                ? "border-rose-500/20 bg-rose-500/[0.03] hover:border-rose-500/40 opacity-50"
                : "border-transparent hover:border-white/10 hover:bg-white/5",
        )}>
            <div className="flex items-start gap-2">
                <span className={cn(
                    "mt-1 select-none",
                    bullet.locked ? "text-amber-400" : bullet.excluded ? "text-rose-400/70" : "text-white/30",
                )}>•</span>

                <div className="flex-1 min-w-0">
                    {editing ? (
                        <textarea
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commit}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
                                if (e.key === 'Escape') { setDraft(bullet.text); setEditing(false); }
                            }}
                            rows={Math.max(1, Math.min(6, draft.split('\n').length))}
                            className="w-full bg-black/40 border border-white/20 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500/50 resize-none"
                        />
                    ) : (
                        <p
                            onClick={startEdit}
                            className={cn(
                                "text-sm cursor-text whitespace-pre-wrap",
                                bullet.excluded ? "text-white/50 line-through decoration-rose-500/40" : "text-white/85",
                            )}
                            title="Click to edit"
                        >
                            {bullet.text}
                        </p>
                    )}

                    <div className="mt-1 flex flex-wrap gap-1 items-center">
                        {bullet.tags
                            .slice()
                            .sort((a, b) => {
                                const aPinned = bullet.pinnedTags.includes(a);
                                const bPinned = bullet.pinnedTags.includes(b);
                                if (aPinned === bPinned) return 0;
                                return aPinned ? -1 : 1;
                            })
                            .map((tag) => {
                            // M8.5.6 Decision 6.3 — auto-added tags get a
                            // Sparkles icon + cyan border until next save folds
                            // them in. M7.7.6 — pinned tags get a Pin icon +
                            // amber border. A tag can be both auto AND pinned
                            // ("auto-suggested but locked in") — both glyphs
                            // render. M7.7.6 — chip body is non-interactive
                            // (rendered as <span>, no onClick); only the
                            // explicit X-icon button removes the tag, and only
                            // the Pin-icon button toggles the pin. The pin
                            // border takes precedence over the auto border
                            // since pin is the stronger commitment.
                            const isAuto = bullet.autoTags.includes(tag);
                            const isPinned = bullet.pinnedTags.includes(tag);
                            return (
                                <span
                                    key={tag}
                                    className={cn(
                                        "group/tag inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-white/60 bg-white/5 border rounded pl-1 pr-1 py-0.5 transition-colors",
                                        isPinned ? "border-amber-500/40 bg-amber-500/[0.06]" :
                                        isAuto ? "border-cyan-500/30" :
                                        "border-white/10",
                                    )}
                                >
                                    <button
                                        onClick={() => togglePin(tag)}
                                        className={cn(
                                            "p-0.5 rounded transition-colors",
                                            isPinned
                                                ? "text-amber-400 hover:text-amber-300"
                                                : "text-white/20 opacity-0 group-hover/tag:opacity-100 hover:text-amber-400/80",
                                        )}
                                        title={isPinned
                                            ? `Unpin "${tag}" — AI tag-suggest may replace it`
                                            : `Pin "${tag}" — AI tag-suggest will keep this tag`}
                                        aria-pressed={isPinned}
                                    >
                                        <Pin className={cn("w-2.5 h-2.5", isPinned && "fill-current")} />
                                    </button>
                                    {isAuto && (
                                        <Sparkles
                                            className="w-2 h-2 text-cyan-400/80"
                                            aria-label="Auto-added"
                                        />
                                    )}
                                    <span className="px-0.5">{tag}</span>
                                    <button
                                        onClick={() => removeTag(tag)}
                                        className="p-0.5 rounded text-white/30 hover:text-rose-300 hover:bg-rose-500/10 opacity-0 group-hover/tag:opacity-100 transition-opacity"
                                        title={`Remove tag "${tag}" — adds to this bullet's blocklist`}
                                    >
                                        <X className="w-2.5 h-2.5" />
                                    </button>
                                </span>
                            );
                        })}
                        {addingTag ? (
                            <input
                                autoFocus
                                type="text"
                                value={tagDraft}
                                onChange={(e) => setTagDraft(e.target.value)}
                                onBlur={commitTag}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); commitTag(); }
                                    if (e.key === 'Escape') { setAddingTag(false); setTagDraft(""); }
                                }}
                                placeholder="tag…"
                                maxLength={TAG_MAX_LENGTH}
                                className="text-[10px] uppercase tracking-wider bg-black/40 border border-white/20 rounded px-1.5 py-0.5 text-white/80 placeholder-white/30 focus:outline-none focus:border-blue-500/50 w-20"
                            />
                        ) : (
                            <button
                                onClick={() => setAddingTag(true)}
                                className="flex items-center gap-0.5 text-[10px] text-white/30 hover:text-white/70 border border-dashed border-white/15 hover:border-white/30 rounded px-1.5 py-0.5 transition-colors"
                                title="Add a tag"
                            >
                                <Plus className="w-2.5 h-2.5" />
                                <span className="uppercase tracking-wider">tag</span>
                            </button>
                        )}
                    </div>
                </div>

                <div className={cn(
                    "flex items-center gap-0.5 transition-opacity",
                    lockBtnAlwaysVisible || excludeBtnAlwaysVisible || rewriting || suggestingTags
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                )}>
                    {wandVisible && (
                        <button
                            onClick={handleRewrite}
                            disabled={rewriting}
                            className={cn(
                                "p-1 rounded hover:bg-white/10 disabled:cursor-not-allowed",
                                rewriting
                                    ? "text-purple-400 opacity-100"
                                    : "text-white/30 hover:text-purple-400",
                            )}
                            title={rewriting ? "Rewriting…" : "Rewrite this bullet's text with AI (tags unchanged)"}
                        >
                            <Sparkles className={cn("w-3 h-3", rewriting && "animate-pulse")} />
                        </button>
                    )}
                    {tagsButtonVisible && (
                        <button
                            onClick={handleSuggestTags}
                            disabled={suggestingTags}
                            className={cn(
                                "p-1 rounded hover:bg-white/10 disabled:cursor-not-allowed",
                                suggestingTags
                                    ? "text-cyan-400 opacity-100"
                                    : "text-white/30 hover:text-cyan-400",
                            )}
                            title={suggestingTags ? "Suggesting tags…" : "Suggest tags with AI (text unchanged, pinned tags preserved)"}
                        >
                            <Tags className={cn("w-3 h-3", suggestingTags && "animate-pulse")} />
                        </button>
                    )}
                    <button
                        onClick={() => onChange({ ...bullet, locked: !bullet.locked, excluded: bullet.locked ? bullet.excluded : false })}
                        className={cn(
                            "p-1 rounded hover:bg-white/10",
                            bullet.locked ? "text-amber-400 opacity-100" : "text-white/30 hover:text-white/60",
                        )}
                        title={bullet.locked
                            ? "🔒 Always included — click to unlock"
                            : "Lock this bullet so it's always included in generated resumes"}
                        aria-pressed={bullet.locked}
                    >
                        {bullet.locked ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
                    </button>
                    <button
                        onClick={() => onChange({ ...bullet, excluded: !bullet.excluded, locked: bullet.excluded ? bullet.locked : false })}
                        className={cn(
                            "p-1 rounded hover:bg-white/10",
                            bullet.excluded ? "text-rose-400 opacity-100" : "text-white/30 hover:text-white/60",
                        )}
                        title={bullet.excluded
                            ? "🚫 Excluded — click to re-include"
                            : "Exclude this bullet from every generated resume"}
                        aria-pressed={bullet.excluded}
                    >
                        {bullet.excluded ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                    <button
                        onClick={onDelete}
                        className="p-1 rounded text-white/30 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100"
                        title="Delete bullet permanently"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {rewriteError && (
                <div className="ml-5 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-2 py-1">
                    {rewriteError}
                </div>
            )}

            {tagSuggestError && (
                <div className="ml-5 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-2 py-1">
                    {tagSuggestError}
                </div>
            )}

            {/* M7.7.2 — rewrite diff panel is now TEXT-ONLY. Tag diff section
                removed; tags pass through unchanged on Accept. */}
            {proposal && (
                <div className="ml-5 mt-1 flex flex-col gap-1.5 rounded-md border border-purple-500/30 bg-purple-500/[0.04] p-2">
                    <div>
                        <span className="text-[10px] uppercase tracking-wider text-white/40">Original</span>
                        <p className="text-sm text-white/40 line-through decoration-rose-400/50 whitespace-pre-wrap">
                            {bullet.text}
                        </p>
                    </div>
                    <div>
                        <span className="text-[10px] uppercase tracking-wider text-white/40">Proposed</span>
                        <p className="text-sm text-emerald-300 whitespace-pre-wrap">
                            {proposal.text}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 pt-0.5">
                        <button
                            onClick={acceptProposal}
                            className="px-2 py-1 text-xs font-medium rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition-colors"
                            title="Replace the bullet's text (tags unchanged)"
                        >
                            Accept
                        </button>
                        <button
                            onClick={discardProposal}
                            className="px-2 py-1 text-xs font-medium rounded bg-white/5 hover:bg-white/10 text-white/60 border border-white/15 transition-colors"
                            title="Keep the original; discard the proposal"
                        >
                            Discard
                        </button>
                    </div>
                </div>
            )}

            {/* M7.7.7 — tag-suggest diff panel. Renders side-by-side current
                tags (with pin/auto annotations) and proposed tags (added in
                emerald, removed in rose line-through). Pins are visually
                distinct in both columns so the user can verify they
                survived the proposal. */}
            {tagProposal && (() => {
                const origTags = bullet.tags;
                const propTags = tagProposal.tags;
                const origSet = new Set(origTags.map(t => t.toLowerCase()));
                const propSet = new Set(propTags.map(t => t.toLowerCase()));
                const dropped = origTags.filter(t => !propSet.has(t.toLowerCase()));
                const added = propTags.filter(t => !origSet.has(t.toLowerCase()));
                const kept = propTags.filter(t => origSet.has(t.toLowerCase()));
                return (
                    <div className="ml-5 mt-1 flex flex-col gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/[0.04] p-2">
                        <div>
                            <span className="text-[10px] uppercase tracking-wider text-white/40">Current tags</span>
                            {origTags.length === 0 ? (
                                <p className="text-xs text-white/40 italic">(none)</p>
                            ) : (
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {origTags.map(t => {
                                        const stillThere = propSet.has(t.toLowerCase());
                                        const isPinned = bullet.pinnedTags.includes(t);
                                        const isAuto = bullet.autoTags.includes(t);
                                        return (
                                            <span
                                                key={`orig-${t}`}
                                                className={cn(
                                                    "inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border",
                                                    stillThere
                                                        ? "text-white/60 border-white/15"
                                                        : "text-rose-300/70 border-rose-500/30 line-through decoration-rose-400/50",
                                                    isPinned && "border-amber-500/40",
                                                )}
                                                title={isPinned ? "Pinned — preserved in proposal" : undefined}
                                            >
                                                {isPinned && <Pin className="w-2.5 h-2.5 fill-current text-amber-400" />}
                                                {isAuto && !isPinned && <Sparkles className="w-2 h-2 text-cyan-400/80" />}
                                                <span>{t}</span>
                                            </span>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        <div>
                            <span className="text-[10px] uppercase tracking-wider text-white/40">Proposed tags</span>
                            <div className="mt-1 flex flex-wrap gap-1">
                                {propTags.map(t => {
                                    const isNew = !origSet.has(t.toLowerCase());
                                    const isPinned = bullet.pinnedTags.includes(t);
                                    return (
                                        <span
                                            key={`prop-${t}`}
                                            className={cn(
                                                "inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border",
                                                isNew
                                                    ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
                                                    : "text-white/60 border-white/15",
                                                isPinned && "border-amber-500/40",
                                            )}
                                            title={isPinned ? "Pinned — server preserved" : (isNew ? "Newly proposed" : "Kept from current tags")}
                                        >
                                            {isPinned && <Pin className="w-2.5 h-2.5 fill-current text-amber-400" />}
                                            <span>{t}</span>
                                        </span>
                                    );
                                })}
                            </div>
                            <p className="mt-1 text-[10px] text-white/40 italic">
                                {kept.length} kept · {added.length > 0 && `${added.length} added`}
                                {added.length > 0 && dropped.length > 0 && ' · '}
                                {dropped.length > 0 && `${dropped.length} dropped`}
                            </p>
                        </div>
                        {tagProposal.reason && (
                            <p className="text-[11px] text-white/50 italic border-l-2 border-cyan-500/40 pl-2">
                                {tagProposal.reason}
                            </p>
                        )}
                        <div className="flex items-center gap-2 pt-0.5">
                            <button
                                onClick={acceptTagProposal}
                                className="px-2 py-1 text-xs font-medium rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition-colors"
                                title="Apply the proposed tag list (text unchanged)"
                            >
                                Accept
                            </button>
                            <button
                                onClick={discardTagProposal}
                                className="px-2 py-1 text-xs font-medium rounded bg-white/5 hover:bg-white/10 text-white/60 border border-white/15 transition-colors"
                                title="Keep current tags; discard the proposal"
                            >
                                Discard
                            </button>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
};
