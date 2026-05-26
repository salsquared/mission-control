"use client";
import React, { useState, useRef, useEffect, useMemo } from "react";
import {
    User as UserIcon,
    Mail,
    Phone,
    MapPin,
    Plus,
    Trash2,
    Sparkles,
    Heart,
    Languages as LanguagesIcon,
    X,
    type LucideIcon,
} from "lucide-react";
import { Card } from "../../ui/Card";
import { EditableField } from "../../ui/EditableField";
import { cn } from "@/lib/utils";
import {
    LANGUAGE_PROFICIENCIES,
    type ProfileLink,
    type SkillGroup,
    type LanguageEntry,
    type LanguageProficiency,
} from "@/lib/profile/types";

// Suggestion list for the language combobox. Not exhaustive — input accepts
// any free-form value so less-common languages aren't blocked.
const COMMON_LANGUAGES = [
    'English', 'Mandarin Chinese', 'Spanish', 'Hindi', 'Arabic', 'Bengali',
    'Portuguese', 'Russian', 'Japanese', 'Punjabi', 'German', 'Korean',
    'French', 'Telugu', 'Marathi', 'Turkish', 'Tamil', 'Vietnamese', 'Urdu',
    'Italian', 'Persian (Farsi)', 'Polish', 'Ukrainian', 'Dutch', 'Greek',
    'Hebrew', 'Thai', 'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Czech',
    'Romanian', 'Hungarian', 'Indonesian', 'Malay', 'Filipino (Tagalog)',
    'Swahili', 'Yoruba', 'Hausa', 'Zulu', 'Amharic', 'Cantonese', 'Mongolian',
    'Khmer', 'Lao', 'Burmese', 'Sinhala', 'Pashto', 'Kurdish', 'Hawaiian',
    'Welsh', 'Irish Gaelic', 'Scottish Gaelic', 'Catalan', 'Basque', 'Maori',
    'Haitian Creole', 'Serbian', 'Croatian', 'Slovak', 'Slovenian', 'Bulgarian',
] as const;

// HeaderPatch is the union of every field this card writes — headline +
// summary + contact + skills/hobbies/languages. Each setter on the parent
// view dispatches through this single patch shape.
export type PersonalInfoPatch = {
    headline?: string | null;
    summary?: string | null;
    location?: string | null;
    email?: string | null;
    phone?: string | null;
    links?: ProfileLink[] | null;
    skills?: SkillGroup[] | null;
    hobbies?: string[] | null;
    languages?: LanguageEntry[] | null;
};

interface PersonalInfoCardProps {
    headline: string | null;
    summary: string | null;
    location: string | null;
    email: string | null;
    phone: string | null;
    skills: SkillGroup[] | null;
    hobbies: string[] | null;
    languages: LanguageEntry[] | null;
    onSave: (patch: PersonalInfoPatch) => void;
}

const SubsectionHeader: React.FC<{ icon: LucideIcon; title: string; colorClass: string }> = ({
    icon: Icon,
    title,
    colorClass,
}) => (
    <div className={`flex items-center gap-2 ${colorClass}`}>
        <Icon className="w-4 h-4" />
        <h3 className="font-bold tracking-wider uppercase text-sm">{title}</h3>
    </div>
);

// Per-theme color classes for the badge + radio primitives below. Keyed off
// a small string union so each editor can pick its accent without the
// primitive knowing about specific colors.
type ThemeColor = 'purple' | 'pink' | 'amber';
const THEME_BADGE: Record<ThemeColor, string> = {
    purple: 'bg-purple-600 text-white',
    pink: 'bg-pink-500 text-white',
    amber: 'bg-amber-600 text-white',
};
const THEME_INPUT_FOCUS: Record<ThemeColor, string> = {
    purple: 'focus:border-purple-500/50',
    pink: 'focus:border-pink-500/50',
    amber: 'focus:border-amber-500/50',
};
const THEME_DOT_ON: Record<ThemeColor, string> = {
    purple: 'bg-purple-400 border-purple-300',
    pink: 'bg-pink-400 border-pink-300',
    amber: 'bg-amber-400 border-amber-300',
};
const THEME_LABEL_ON: Record<ThemeColor, string> = {
    purple: 'text-purple-200',
    pink: 'text-pink-200',
    amber: 'text-amber-200',
};

// ─── BadgeList: input anchored on top, removable pills flow below ─────────
const BadgeList: React.FC<{
    items: string[];
    onChange: (next: string[]) => void;
    placeholder: string;
    theme: ThemeColor;
}> = ({ items, onChange, placeholder, theme }) => {
    const [draft, setDraft] = useState('');
    const commit = () => {
        const v = draft.trim();
        setDraft('');
        if (!v) return;
        if (items.includes(v)) return; // dedup, silently drop
        onChange([...items, v]);
    };
    const remove = (idx: number) => onChange(items.filter((_, i) => i !== idx));
    return (
        <div className="flex flex-col gap-2">
            <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commit(); }
                }}
                onBlur={commit}
                placeholder={placeholder}
                className={cn(
                    'w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-white/90 placeholder:text-white/30 focus:outline-none transition-colors',
                    THEME_INPUT_FOCUS[theme],
                )}
            />
            {items.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {items.map((it, idx) => (
                        <span
                            key={`${it}-${idx}`}
                            className={cn(
                                'inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs',
                                THEME_BADGE[theme],
                            )}
                        >
                            {it}
                            <button
                                type="button"
                                onClick={() => remove(idx)}
                                className="opacity-70 hover:opacity-100 transition-opacity rounded-full hover:bg-white/10 p-0.5"
                                title="Remove"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};

// ─── ProficiencyRadio: low → high left → right, vertical dot+label ──────────
const ProficiencyRadio: React.FC<{
    value: LanguageProficiency;
    onChange: (next: LanguageProficiency) => void;
    theme: ThemeColor;
}> = ({ value, onChange, theme }) => (
    <div className="flex items-start justify-between gap-1 w-full">
        {LANGUAGE_PROFICIENCIES.map((p) => {
            const active = p === value;
            return (
                <button
                    key={p}
                    type="button"
                    onClick={() => onChange(p)}
                    className="flex flex-col items-center gap-1 flex-1 group min-w-0"
                    title={p}
                >
                    <span
                        className={cn(
                            'w-3 h-3 rounded-full border transition-colors',
                            active ? THEME_DOT_ON[theme] : 'border-white/30 group-hover:border-white/60',
                        )}
                    />
                    <span
                        className={cn(
                            'text-[9px] uppercase tracking-wider transition-colors truncate w-full text-center',
                            active ? THEME_LABEL_ON[theme] : 'text-white/40 group-hover:text-white/70',
                        )}
                    >
                        {p}
                    </span>
                </button>
            );
        })}
    </div>
);

// ─── LanguageDraft: combobox + radio + Add/Cancel ──────────────────────────
const LanguageDraft: React.FC<{
    onCommit: (entry: LanguageEntry) => void;
    onCancel: () => void;
    existingNames: string[];
}> = ({ onCommit, onCancel, existingNames }) => {
    const [name, setName] = useState('');
    const [proficiency, setProficiency] = useState<LanguageProficiency>('Conversational');
    const [open, setOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { inputRef.current?.focus(); }, []);

    const trimmed = name.trim();
    const existsLower = useMemo(
        () => new Set(existingNames.map((n) => n.toLowerCase())),
        [existingNames],
    );
    const isDuplicate = trimmed.length > 0 && existsLower.has(trimmed.toLowerCase());
    const canCommit = trimmed.length > 0 && !isDuplicate;

    const filtered = useMemo(() => {
        const q = trimmed.toLowerCase();
        const pool = q
            ? COMMON_LANGUAGES.filter((l) => l.toLowerCase().includes(q))
            : COMMON_LANGUAGES;
        return pool.filter((l) => !existsLower.has(l.toLowerCase())).slice(0, 6);
    }, [trimmed, existsLower]);

    return (
        <div className="bg-black/30 rounded-lg p-3 flex flex-col gap-3 border border-amber-500/20">
            <div className="relative">
                <input
                    ref={inputRef}
                    value={name}
                    onChange={(e) => { setName(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setTimeout(() => setOpen(false), 120)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && canCommit) {
                            e.preventDefault();
                            onCommit({ name: trimmed, proficiency });
                        } else if (e.key === 'Escape') {
                            onCancel();
                        }
                    }}
                    placeholder="Language (type to search)"
                    className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm text-white/90 focus:outline-none focus:border-amber-500/50 placeholder:text-white/30"
                />
                {open && filtered.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-white/10 rounded shadow-xl z-10 max-h-48 overflow-y-auto">
                        {filtered.map((l) => (
                            <button
                                key={l}
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { setName(l); setOpen(false); }}
                                className="block w-full text-left px-2 py-1.5 text-sm text-white/80 hover:bg-amber-500/10"
                            >
                                {l}
                            </button>
                        ))}
                    </div>
                )}
                {isDuplicate && (
                    <p className="mt-1 text-[10px] text-red-300/80">Already added</p>
                )}
            </div>
            <ProficiencyRadio value={proficiency} onChange={setProficiency} theme="amber" />
            <div className="flex gap-2 justify-end pt-1">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-3 py-1 text-xs text-white/60 hover:text-white/90 rounded transition-colors"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    disabled={!canCommit}
                    onClick={() => onCommit({ name: trimmed, proficiency })}
                    className="px-3 py-1 text-xs bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 rounded text-amber-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    Add
                </button>
            </div>
        </div>
    );
};

// ─── Section editors ──────────────────────────────────────────────────────
const SkillsEditor: React.FC<{
    skills: SkillGroup[] | null;
    onChange: (next: SkillGroup[] | null) => void;
}> = ({ skills, onChange }) => {
    const groups = skills ?? [];
    const updateGroup = (idx: number, patch: Partial<SkillGroup>) => {
        const next = groups.map((g, i) => (i === idx ? { ...g, ...patch } : g));
        onChange(next.length ? next : null);
    };
    const deleteGroup = (idx: number) => {
        const next = groups.filter((_, i) => i !== idx);
        onChange(next.length ? next : null);
    };
    const addGroup = () => {
        onChange([...groups, { category: 'New category', items: [] }]);
    };
    return (
        <div className="flex flex-col gap-3">
            {groups.length === 0 && (
                <p className="text-xs text-white/40 italic">No skills yet.</p>
            )}
            {groups.map((g, idx) => (
                <div key={idx} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                        <EditableField
                            value={g.category}
                            onSave={(v) => v && updateGroup(idx, { category: v })}
                            placeholder="Category"
                            readClassName="text-[10px] uppercase tracking-wider font-semibold text-purple-300"
                        />
                        <button
                            type="button"
                            onClick={() => deleteGroup(idx)}
                            className="text-white/30 hover:text-red-400 transition-colors p-1 shrink-0"
                            title="Remove category"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <BadgeList
                        items={g.items}
                        onChange={(items) => updateGroup(idx, { items })}
                        placeholder="Add skill"
                        theme="purple"
                    />
                </div>
            ))}
            <button
                type="button"
                onClick={addGroup}
                className="self-start flex items-center gap-1.5 px-2.5 py-1 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 rounded text-[11px] font-semibold text-purple-300 transition-colors"
            >
                <Plus className="w-3 h-3" /> Add category
            </button>
        </div>
    );
};

const HobbiesEditor: React.FC<{
    hobbies: string[] | null;
    onChange: (next: string[] | null) => void;
}> = ({ hobbies, onChange }) => (
    <BadgeList
        items={hobbies ?? []}
        onChange={(items) => onChange(items.length ? items : null)}
        placeholder="Add hobby"
        theme="pink"
    />
);

const LanguagesEditor: React.FC<{
    languages: LanguageEntry[] | null;
    onChange: (next: LanguageEntry[] | null) => void;
}> = ({ languages, onChange }) => {
    const entries = languages ?? [];
    const [adding, setAdding] = useState(false);

    const updateEntry = (idx: number, patch: Partial<LanguageEntry>) => {
        const next = entries.map((e, i) => (i === idx ? { ...e, ...patch } : e));
        onChange(next.length ? next : null);
    };
    const deleteEntry = (idx: number) => {
        const next = entries.filter((_, i) => i !== idx);
        onChange(next.length ? next : null);
    };
    const commitNew = (entry: LanguageEntry) => {
        onChange([...entries, entry]);
        setAdding(false);
    };

    return (
        <div className="flex flex-col gap-2">
            {entries.length === 0 && !adding && (
                <p className="text-xs text-white/40 italic">No languages yet.</p>
            )}
            {entries.map((e, idx) => (
                <div
                    key={`${e.name}-${idx}`}
                    className="flex flex-col gap-2 p-2 rounded bg-black/20 border border-white/5"
                >
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-white/90 font-medium truncate">{e.name}</span>
                        <button
                            type="button"
                            onClick={() => deleteEntry(idx)}
                            className="text-white/30 hover:text-red-400 transition-colors p-1 shrink-0"
                            title="Remove language"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <ProficiencyRadio
                        value={e.proficiency}
                        onChange={(next) => updateEntry(idx, { proficiency: next })}
                        theme="amber"
                    />
                </div>
            ))}
            {adding ? (
                <LanguageDraft
                    onCommit={commitNew}
                    onCancel={() => setAdding(false)}
                    existingNames={entries.map((e) => e.name)}
                />
            ) : (
                <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="self-start flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded text-[11px] font-semibold text-amber-300 transition-colors"
                >
                    <Plus className="w-3 h-3" /> Add language
                </button>
            )}
        </div>
    );
};

export const PersonalInfoCard: React.FC<PersonalInfoCardProps> = ({
    headline,
    summary,
    location,
    email,
    phone,
    skills,
    hobbies,
    languages,
    onSave,
}) => {
    return (
        <Card
            title="Personal info"
            icon={UserIcon}
            iconColorClass="text-purple-300"
        >
            <div className="flex flex-col gap-8">
                {/* Identity essentials — headline / summary / contact */}
                <section className="flex flex-col gap-3">
                    <div>
                        <span className="text-[10px] uppercase tracking-wider text-white/30">Headline</span>
                        <EditableField
                            value={headline}
                            onSave={(v) => onSave({ headline: v })}
                            placeholder="Click to add a headline (e.g. 'Senior Engineer · Distributed Systems')"
                            readClassName="text-lg font-semibold text-white"
                        />
                    </div>
                    <div>
                        <span className="text-[10px] uppercase tracking-wider text-white/30">Summary</span>
                        <EditableField
                            value={summary}
                            onSave={(v) => onSave({ summary: v })}
                            placeholder="One-paragraph elevator pitch"
                            multiline
                            readClassName="text-sm text-white/70 whitespace-pre-wrap"
                        />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-1">
                        <div className="flex items-center gap-2">
                            <MapPin className="w-3.5 h-3.5 text-white/40 shrink-0" />
                            <EditableField
                                value={location}
                                onSave={(v) => onSave({ location: v })}
                                placeholder="Location"
                                readClassName="text-sm text-white/80"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Mail className="w-3.5 h-3.5 text-white/40 shrink-0" />
                            <EditableField
                                value={email}
                                onSave={(v) => onSave({ email: v })}
                                placeholder="Email"
                                type="email"
                                readClassName="text-sm text-white/80"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Phone className="w-3.5 h-3.5 text-white/40 shrink-0" />
                            <EditableField
                                value={phone}
                                onSave={(v) => onSave({ phone: v })}
                                placeholder="Phone"
                                type="tel"
                                readClassName="text-sm text-white/80"
                            />
                        </div>
                    </div>
                </section>

                {/* Skills · Hobbies · Languages — 3-column row */}
                <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="flex flex-col gap-3 min-w-0">
                        <SubsectionHeader icon={Sparkles} title="Skills" colorClass="text-purple-400" />
                        <SkillsEditor
                            skills={skills}
                            onChange={(next) => onSave({ skills: next })}
                        />
                    </div>
                    <div className="flex flex-col gap-3 min-w-0">
                        <SubsectionHeader icon={Heart} title="Hobbies" colorClass="text-pink-400" />
                        <HobbiesEditor
                            hobbies={hobbies}
                            onChange={(next) => onSave({ hobbies: next })}
                        />
                    </div>
                    <div className="flex flex-col gap-3 min-w-0">
                        <SubsectionHeader icon={LanguagesIcon} title="Languages" colorClass="text-amber-400" />
                        <LanguagesEditor
                            languages={languages}
                            onChange={(next) => onSave({ languages: next })}
                        />
                    </div>
                </section>
            </div>
        </Card>
    );
};
