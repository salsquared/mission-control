import React from "react";
import { isValidUrl } from "@/lib/profile/links";
import type {
    ProfileWire,
    WorkRoleWire,
    ProjectWire,
    EducationWire,
} from "@/lib/schemas/profile";
import type { ResumeSelection, ExtrasSelection } from "@/lib/resumes/select";
import type { RewrittenBullet } from "@/lib/resumes/rewrite";
import { DEFAULT_SECTION_ORDER, type SectionKey } from "@/lib/resumes/tagline-tailor";

interface ResumeProps {
    profile: ProfileWire;
    // Posting-tailored override for the subtitle under the H1. When null
    // (legacy rows, AIError fallback, or `replay` of an old artifact), the
    // template renders `profile.tagline` instead so historical resumes
    // still get a subtitle.
    tagline: string | null;
    sections: {
        workRoles: { entity: WorkRoleWire; bullets: { id: string; text: string }[] }[];
        projects: { entity: ProjectWire; bullets: { id: string; text: string }[] }[];
        education: { entity: EducationWire; bullets: { id: string; text: string }[] }[];
    };
    // Posting-relevance-filtered skills / languages / hobbies. Each section
    // is omitted from the rendered output when empty. See
    // `selectProfileExtras` in lib/resumes/select.ts for the matcher.
    extras: ExtrasSelection;
    // Order in which the six sections render. LLM-supplied via resume-tagline;
    // defaults to DEFAULT_SECTION_ORDER when no override is provided. Sections
    // with no content are still omitted from the rendered output regardless
    // of their position in this array.
    sectionOrder: readonly SectionKey[];
}

export function composeResumeProps(
    profile: ProfileWire,
    selection: ResumeSelection,
    rewrites: RewrittenBullet[],
    tagline: string | null = null,
    extras: ExtrasSelection = { skills: [], languages: [], hobbies: [] },
    sectionOrder: readonly SectionKey[] = DEFAULT_SECTION_ORDER,
): ResumeProps {
    const rewriteById = new Map(rewrites.map(r => [r.id, r.rewrittenText]));
    const render = <E,>(group: { entity: E; bullets: { bulletId: string; originalText: string }[] }[]) =>
        group.map(g => ({
            entity: g.entity,
            bullets: g.bullets.map(b => ({
                id: b.bulletId,
                text: rewriteById.get(b.bulletId) ?? b.originalText,
            })),
        }));
    return {
        profile,
        tagline,
        sections: {
            workRoles: render(selection.workRoles),
            projects: render(selection.projects),
            education: render(selection.education),
        },
        extras,
        sectionOrder,
    };
}

function fmtDate(d: string | null): string {
    if (!d) return "Present";
    const dt = new Date(d);
    return dt.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function fmtDateRange(start: string | null, end: string | null): string {
    if (!start && !end) return "";
    return `${start ? fmtDate(start) : "?"} – ${end ? fmtDate(end) : "Present"}`;
}

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #111;
  font-size: 10.5pt;
  line-height: 1.35;
}
.page { padding: 0.5in 0.6in; }
.header { text-align: center; margin-bottom: 0.18in; }
.header h1 { font-size: 18pt; margin: 0 0 2px 0; font-weight: 700; letter-spacing: 0.02em; }
.header .tagline { font-size: 10.5pt; color: #444; font-style: italic; margin: 0 0 4px 0; }
.header .meta { font-size: 9.5pt; color: #333; }
.header .meta a { color: #1b56b8; text-decoration: none; }
.section { margin-top: 0.16in; }
.section h2 {
  font-size: 11pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-bottom: 1px solid #999;
  padding-bottom: 2px;
  margin: 0 0 0.06in 0;
}
.entity { margin-bottom: 0.08in; page-break-inside: avoid; }
.entity-line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 1px;
  gap: 0.2in;
}
.entity-line .title { font-weight: 700; }
.entity-line .right { color: #444; font-size: 9.5pt; white-space: nowrap; }
.entity-sub { color: #444; font-size: 9.5pt; font-style: italic; }
ul.bullets { margin: 2px 0 0 0.22in; padding: 0; }
ul.bullets li { margin-bottom: 1px; }
.extras-line { margin-bottom: 2px; }
.extras-line .label { font-weight: 700; }
.extras-inline { display: inline; }
/* 2026-05-27: lay the three extras sections (Skills / Languages / Interests)
   side-by-side as flex items so a 3-item Skills list + a 4-language list +
   a 1-interest line don't eat 3 × (heading + content) of vertical space.
   flex-wrap keeps anything that overflows on the next row. The 2in flex-
   basis ensures each section is at least readable; a Letter page's 7.3in
   content width fits 3 columns at ~2.4in each. */
.extras-row { display: flex; flex-wrap: wrap; gap: 0 0.4in; align-items: flex-start; }
.extras-row > .section { flex: 1 1 2in; min-width: 0; }
`;

// 2026-05-27: render the (up to) three "extras" sections — Skills, Languages,
// Interests — as a single flex-row block so short lists pack side-by-side
// instead of eating three separate (heading + content) rows of vertical
// space. Section order within the row is whatever sectionOrder asked for.
// Empty sections drop out individually; if all three are empty, the whole
// row is null and the wrapper isn't rendered.
function renderExtrasRow(keysInOrder: SectionKey[], extras: ExtrasSelection): React.ReactNode {
    const cards: React.ReactNode[] = [];
    for (const k of keysInOrder) {
        if (k === "skills" && extras.skills.length > 0) {
            cards.push(
                <section key="skills" className="section">
                    <h2>Skills</h2>
                    {extras.skills.map(g => (
                        <div key={g.category} className="extras-line">
                            <span className="label">{g.category}: </span>
                            <span className="extras-inline">{g.items.join(", ")}</span>
                        </div>
                    ))}
                </section>,
            );
        } else if (k === "languages" && extras.languages.length > 0) {
            cards.push(
                <section key="languages" className="section">
                    <h2>Languages</h2>
                    <div className="extras-line">
                        {extras.languages.map((l, i) => (
                            <React.Fragment key={l.name}>
                                {i > 0 ? ", " : null}
                                <span>{l.name} ({l.proficiency})</span>
                            </React.Fragment>
                        ))}
                    </div>
                </section>,
            );
        } else if (k === "interests" && extras.hobbies.length > 0) {
            cards.push(
                <section key="interests" className="section">
                    <h2>Interests</h2>
                    <div className="extras-line">{extras.hobbies.join(", ")}</div>
                </section>,
            );
        }
    }
    if (cards.length === 0) return null;
    return <div key="extras-row" className="extras-row">{cards}</div>;
}

function ResumeDoc({ profile, tagline, sections, extras, sectionOrder }: ResumeProps) {
    // Defense in depth — even if legacy corrupt entries (e.g. {url:"Github"})
    // exist in the DB, they shouldn't render as broken links in the resume.
    const links = (profile.links ?? []).filter(l => isValidUrl(l.url));
    // Posting-tailored tagline wins when present. Legacy rows (no row-level
    // tagline) fall back to the user's profile-level pitch.
    const renderedTagline = tagline ?? profile.tagline ?? null;
    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <title>{`Resume — ${profile.headline ?? "Profile"}`}</title>
                <style dangerouslySetInnerHTML={{ __html: CSS }} />
            </head>
            <body>
                <div className="page">
                    <header className="header">
                        <h1>{profile.headline ?? "Resume"}</h1>
                        {/* One-sentence professional tagline rendered as a
                            subtitle directly under the H1 when set. Italic +
                            slightly smaller than the name + above the meta
                            contact line. Posting-tailored (resume-tagline
                            callsite) if available; falls back to the user's
                            profile.tagline for legacy rows. */}
                        {renderedTagline ? <p className="tagline">{renderedTagline}</p> : null}
                        <div className="meta">
                            {[profile.location, profile.email, profile.phone].filter(Boolean).join("  ·  ")}
                            {links.length > 0 && profile.location ? "  ·  " : ""}
                            {links.map((l, i) => (
                                <React.Fragment key={l.url}>
                                    {i > 0 ? "  ·  " : null}
                                    <a href={l.url}>{l.label}</a>
                                </React.Fragment>
                            ))}
                        </div>
                        {/* Story S7.14 follow-up (2026-05-26): legacy
                            `profile.summary` block dropped — tagline (rendered
                            above the meta line) is the only one-line pitch
                            now. */}
                    </header>

                    {/* Sections render in sectionOrder. Each renderer is a
                        no-op when its data is empty, so an empty section
                        listed first in the order just doesn't draw. The
                        order is supplied by resume-tagline's LLM output
                        (or DEFAULT_SECTION_ORDER as fallback).

                        2026-05-27: the three "extras" keys (skills /
                        languages / interests) emit as a single flex-row
                        block at the position of the first one in
                        sectionOrder — short lists sit side-by-side instead
                        of stacking three separate sections. Tracked via
                        `extrasEmitted` so subsequent extras keys are
                        no-op. */}
                    {(() => {
                        const EXTRA_KEYS = new Set<SectionKey>(["skills", "languages", "interests"]);
                        const extrasInOrder = sectionOrder.filter(k => EXTRA_KEYS.has(k));
                        let extrasEmitted = false;
                        return sectionOrder.map(key => {
                            if (EXTRA_KEYS.has(key)) {
                                if (extrasEmitted) return null;
                                extrasEmitted = true;
                                return renderExtrasRow(extrasInOrder, extras);
                            }
                            switch (key) {
                            case "experience":
                                return sections.workRoles.length === 0 ? null : (
                                    <section key="experience" className="section">
                                        <h2>Experience</h2>
                                        {sections.workRoles.map(({ entity, bullets }) => (
                                            <div key={entity.id} className="entity">
                                                <div className="entity-line">
                                                    <span className="title">{entity.title} · {entity.company}</span>
                                                    <span className="right">{fmtDateRange(entity.startDate, entity.endDate)}</span>
                                                </div>
                                                {entity.location ? <div className="entity-sub">{entity.location}</div> : null}
                                                {bullets.length > 0 && (
                                                    <ul className="bullets">
                                                        {bullets.map(b => <li key={b.id}>{b.text}</li>)}
                                                    </ul>
                                                )}
                                            </div>
                                        ))}
                                    </section>
                                );
                            case "projects":
                                return sections.projects.length === 0 ? null : (
                                    <section key="projects" className="section">
                                        <h2>Projects</h2>
                                        {sections.projects.map(({ entity, bullets }) => (
                                            <div key={entity.id} className="entity">
                                                <div className="entity-line">
                                                    <span className="title">{entity.name}</span>
                                                    {entity.repoUrl ? <span className="right"><a href={entity.repoUrl}>{entity.repoUrl}</a></span> : null}
                                                </div>
                                                {entity.description ? <div className="entity-sub">{entity.description}</div> : null}
                                                {bullets.length > 0 && (
                                                    <ul className="bullets">
                                                        {bullets.map(b => <li key={b.id}>{b.text}</li>)}
                                                    </ul>
                                                )}
                                            </div>
                                        ))}
                                    </section>
                                );
                            case "education":
                                return sections.education.length === 0 ? null : (
                                    <section key="education" className="section">
                                        <h2>Education</h2>
                                        {sections.education.map(({ entity, bullets }) => (
                                            <div key={entity.id} className="entity">
                                                <div className="entity-line">
                                                    <span className="title">{entity.institution}</span>
                                                    <span className="right">{fmtDateRange(entity.startDate, entity.endDate)}</span>
                                                </div>
                                                {(entity.degree || entity.field) ? (
                                                    <div className="entity-sub">{[entity.degree, entity.field].filter(Boolean).join(", ")}</div>
                                                ) : null}
                                                {bullets.length > 0 && (
                                                    <ul className="bullets">
                                                        {bullets.map(b => <li key={b.id}>{b.text}</li>)}
                                                    </ul>
                                                )}
                                            </div>
                                        ))}
                                    </section>
                                );
                            // skills / languages / interests fall through to
                            // the EXTRA_KEYS branch above (renderExtrasRow);
                            // they never reach this switch.
                            default:
                                return null;
                        }
                        });
                    })()}
                </div>
            </body>
        </html>
    );
}

export type { ResumeProps };
export { ResumeDoc };
