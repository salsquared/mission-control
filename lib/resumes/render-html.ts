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

/**
 * Wrap a bare resume HTML document with on-screen preview chrome: a sticky
 * page-fit banner (the AUTHORITATIVE page count from the real PDF render, not
 * the builder's line-count estimate) and a Letter-sized "sheet" with a guide
 * line at the page-1 boundary, so the user can see whether the resume fits on
 * one page and what spills over — the visual feedback the PDF gave but that a
 * flowing HTML page loses.
 *
 * Geometry mirrors render-pdf.ts's `page.pdf` settings exactly: Letter
 * (8.5in × 11in) with 0.5in margins → 10in of printable height per page. The
 * template's `.page` box starts at the sheet's content top (0.5in below the
 * sheet edge), so page 1 ends 0.5in + 10in down. The text column also matches:
 * sheet 8.5in − 0.5in×2 margin = 7.5in printable, − the template's 0.6in `.page`
 * padding = 6.3in, identical to the PDF, so line wrapping (and thus the boundary)
 * is faithful. Only the page-1 boundary is exact — later breaks drift in a
 * continuous (un-paginated) preview, which is why the banner carries the count.
 *
 * `pageCount` is the exact count from `countPdfPages` on the just-rendered PDF
 * (null when unknown — opened outside the generate flow). The chrome is screen-
 * only (`@media print` strips it) and never touches the PDF/DOCX artifacts,
 * which render from the bare template.
 */
export function decorateResumePreview(html: string, pageCount: number | null): string {
    const fits = pageCount === 1;
    const over = pageCount != null && pageCount > 1;
    const barClass = fits ? "ok" : over ? "warn" : "info";
    const barText = fits
        ? "✓ Fits on one page"
        : over
            ? `⚠ ${pageCount} pages — trim to fit on one page`
            : "Resume preview — links open in their own tab";
    const style = `<style id="mc-preview-chrome">
      html { background: #54585c; }
      body { margin: 0; padding: 0; }
      .mc-fitbar {
        position: sticky; top: 0; z-index: 20;
        padding: 0.5rem 1rem; text-align: center;
        font: 600 13px/1.4 -apple-system, system-ui, sans-serif;
        letter-spacing: 0.01em;
      }
      .mc-fitbar.ok   { background: #137a3a; color: #fff; }
      .mc-fitbar.warn { background: #9c5b00; color: #fff; }
      .mc-fitbar.info { background: #34373b; color: #d6d8da; }
      .mc-sheet {
        position: relative;
        width: 8.5in; min-height: 11in;
        margin: 1.5rem auto 3rem;
        padding: 0.5in;            /* the print page margin (render-pdf.ts) */
        background: #fff;
        box-shadow: 0 2px 24px rgba(0,0,0,0.5);
      }
      .mc-sheet::after {
        content: "page 1 ends here";
        position: absolute; left: 0; right: 0;
        top: calc(0.5in + 10in);   /* sheet content top + 10in printable */
        border-top: 1.5px dashed #b3b3b3;
        color: #9a9a9a; font: 600 9px/1 -apple-system, system-ui, sans-serif;
        text-align: right; padding-right: 4px;
        pointer-events: none;
      }
      @media print {
        .mc-fitbar, .mc-sheet::after { display: none; }
        .mc-sheet { box-shadow: none; margin: 0; padding: 0; width: auto; min-height: 0; }
        html { background: #fff; }
      }
    </style>`;
    return html
        .replace("</head>", style + "</head>")
        .replace("<body>", `<body><div class="mc-fitbar ${barClass}">${barText}</div><div class="mc-sheet">`)
        .replace("</body>", "</div></body>");
}
