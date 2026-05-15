/**
 * File → plain text extraction for resume imports.
 *
 * Supported (Phase 1):
 *   - PDF (application/pdf, .pdf) via pdf-parse v2 (PDFParse class)
 *   - DOCX (application/vnd.openxmlformats-officedocument.wordprocessingml.document, .docx) via mammoth
 *   - TXT (text/plain, .txt)
 *   - JSON (application/json, .json) — pretty-printed
 *
 * Deferred:
 *   - DOC (legacy Word .doc) — mammoth doesn't support it, would need libreoffice or a converter
 *   - RTF — uncommon for modern resumes
 *   - HTML — paste-as-text covers most cases
 *   - LinkedIn export ZIP — separate import path, not raw resume text
 */

export type SupportedKind = "pdf" | "docx" | "txt" | "json";

export interface ExtractedFile {
    filename: string;
    kind: SupportedKind;
    text: string;
    bytes: number;
}

const PDF_EXT = /\.pdf$/i;
const DOCX_EXT = /\.docx$/i;
const TXT_EXT = /\.(txt|md|markdown)$/i;
const JSON_EXT = /\.json$/i;

function kindFor(filename: string, mimeType: string): SupportedKind | null {
    const mt = (mimeType || "").toLowerCase();
    if (mt === "application/pdf" || PDF_EXT.test(filename)) return "pdf";
    if (mt === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || DOCX_EXT.test(filename)) return "docx";
    if (mt === "application/json" || JSON_EXT.test(filename)) return "json";
    if (mt.startsWith("text/") || TXT_EXT.test(filename)) return "txt";
    return null;
}

function tidy(s: string): string {
    return s
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

async function extractPDF(buffer: Buffer): Promise<string> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
        const result = await parser.getText();
        return tidy(result.text ?? "");
    } finally {
        await parser.destroy().catch(() => undefined);
    }
}

async function extractDOCX(buffer: Buffer): Promise<string> {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return tidy(result.value ?? "");
}

function extractTXT(buffer: Buffer): string {
    return tidy(buffer.toString("utf8"));
}

function extractJSON(buffer: Buffer): string {
    const raw = buffer.toString("utf8");
    try {
        const parsed = JSON.parse(raw);
        return tidy(JSON.stringify(parsed, null, 2));
    } catch {
        return tidy(raw);
    }
}

export async function extractText(
    buffer: Buffer,
    mimeType: string,
    filename: string,
): Promise<ExtractedFile> {
    const kind = kindFor(filename, mimeType);
    if (!kind) {
        throw new Error(
            `Unsupported file type: ${filename} (mime: ${mimeType || "?"}). Supported: PDF, DOCX, TXT, JSON.`,
        );
    }
    let text = "";
    switch (kind) {
        case "pdf":
            text = await extractPDF(buffer);
            break;
        case "docx":
            text = await extractDOCX(buffer);
            break;
        case "txt":
            text = extractTXT(buffer);
            break;
        case "json":
            text = extractJSON(buffer);
            break;
    }
    if (text.length < 20) {
        throw new Error(`Extracted text from ${filename} is empty or too short (got ${text.length} chars).`);
    }
    return { filename, kind, text, bytes: buffer.byteLength };
}
