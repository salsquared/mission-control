import React from "react";
import { isValidUrl } from "@/lib/profile/links";
import type {
    ProfileWire,
    WorkRoleWire,
    ProjectWire,
    EducationWire,
} from "@/lib/schemas/profile";
import type { ResumeSelection } from "@/lib/resumes/select";
import type { RewrittenBullet } from "@/lib/resumes/rewrite";

interface ResumeProps {
    profile: ProfileWire;
    sections: {
        workRoles: { entity: WorkRoleWire; bullets: { id: string; text: string }[] }[];
        projects: { entity: ProjectWire; bullets: { id: string; text: string }[] }[];
        education: { entity: EducationWire; bullets: { id: string; text: string }[] }[];
    };
}

export function composeResumeProps(
    profile: ProfileWire,
    selection: ResumeSelection,
    rewrites: RewrittenBullet[],
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
        sections: {
            workRoles: render(selection.workRoles),
            projects: render(selection.projects),
            education: render(selection.education),
        },
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
`;

function ResumeDoc({ profile, sections }: ResumeProps) {
    // Defense in depth — even if legacy corrupt entries (e.g. {url:"Github"})
    // exist in the DB, they shouldn't render as broken links in the resume.
    const links = (profile.links ?? []).filter(l => isValidUrl(l.url));
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
                        {/* M7.9.7 (story S7.14) — one-sentence professional
                            tagline rendered as a subtitle directly under the
                            H1 when set. Italic + slightly smaller than the
                            name + above the meta contact line. */}
                        {profile.tagline ? <p className="tagline">{profile.tagline}</p> : null}
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

                    {sections.workRoles.length > 0 && (
                        <section className="section">
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
                    )}

                    {sections.projects.length > 0 && (
                        <section className="section">
                            <h2>Projects</h2>
                            {sections.projects.map(({ entity, bullets }) => {
                                return (
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
                                );
                            })}
                        </section>
                    )}

                    {sections.education.length > 0 && (
                        <section className="section">
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
                    )}
                </div>
            </body>
        </html>
    );
}

export type { ResumeProps };
export { ResumeDoc };
