import React from "react";
import { ResumeDoc, type ResumeProps } from "@/lib/resumes/templates/ats-plain";

/**
 * Render a ResumeProps into a DOCX buffer.
 *
 * Uses the same React template as the PDF path; the difference is just the
 * final converter. html-to-docx supports a usable subset of HTML/CSS — the
 * ATS-friendly template happens to fit cleanly (single column, simple
 * typography, no images, no flex wizardry).
 *
 * Dynamic-imports both `react-dom/server` and `html-to-docx` so Next's
 * client-boundary analyzer doesn't drag them into a client bundle.
 */
export async function renderResumeDOCX(props: ResumeProps): Promise<Buffer> {
    const { renderToStaticMarkup } = await import("react-dom/server");
    // html-to-docx has no published types and is a CJS module callable directly.
    // @ts-expect-error untyped CJS module
    const HTMLtoDOCXImport = await import("html-to-docx");
    const HTMLtoDOCX = ((HTMLtoDOCXImport as { default?: unknown }).default ?? HTMLtoDOCXImport) as (
        htmlString: string,
        headerHTMLString?: string | null,
        documentOptions?: Record<string, unknown>,
        footerHTMLString?: string | null,
    ) => Promise<Buffer | Blob>;

    const html = "<!doctype html>" + renderToStaticMarkup(React.createElement(ResumeDoc, props));

    const result = await HTMLtoDOCX(html, null, {
        orientation: "portrait",
        pageSize: { width: "8.5in", height: "11in" },
        margins: { top: "0.5in", right: "0.6in", bottom: "0.5in", left: "0.6in" },
        title: props.profile.headline ?? "Resume",
        font: "Helvetica",
        fontSize: 22, // 11pt — html-to-docx uses half-points
        table: { row: { cantSplit: true } },
    });

    if (Buffer.isBuffer(result)) return result;
    // Some versions return a Blob in non-Node environments; convert.
    const ab = await (result as unknown as Blob).arrayBuffer();
    return Buffer.from(ab);
}
