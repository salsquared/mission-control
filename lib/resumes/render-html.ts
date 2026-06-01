import React from "react";
import { ResumeDoc, type ResumeProps } from "@/lib/resumes/templates/ats-plain";

/**
 * Render a ResumeProps into a standalone HTML document string.
 *
 * Same React template that feeds the PDF (render-pdf.ts) and DOCX
 * (render-docx.ts) paths — this is the third consumer, used for the on-screen
 * preview the builder opens in a new tab. The PDF path can't honor
 * `target="_blank"` on its links (Chromium emits plain `/S /URI` PDF
 * annotations with no new-window flag, and Chrome's PDF viewer opens them in
 * the same tab), so a real HTML render is the only surface where clicking a
 * "Repo"/"Website"/contact link reliably opens a new tab instead of replacing
 * the resume the user is reading.
 *
 * Dynamic-imports `react-dom/server` so Next's client-boundary analyzer doesn't
 * drag it into a client bundle (mirrors render-pdf / render-docx).
 */
export async function renderResumeHTML(props: ResumeProps): Promise<string> {
    const { renderToStaticMarkup } = await import("react-dom/server");
    return "<!doctype html>" + renderToStaticMarkup(React.createElement(ResumeDoc, props));
}
