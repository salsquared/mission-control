import React from "react";
import type { Browser } from "puppeteer-core";
import { ResumeDoc, type ResumeProps } from "@/lib/resumes/templates/ats-plain";

const CHROME_PATH =
    process.env.CHROME_EXECUTABLE_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

interface PuppeteerGlobal {
    browser?: Browser | null;
    launching?: Promise<Browser>;
}

const g = globalThis as unknown as { __mcPuppeteer?: PuppeteerGlobal };
if (!g.__mcPuppeteer) g.__mcPuppeteer = {};

async function getBrowser(): Promise<Browser> {
    const slot = g.__mcPuppeteer!;
    if (slot.browser && slot.browser.connected) return slot.browser;
    if (slot.launching) return slot.launching;

    const { default: puppeteer } = await import("puppeteer-core");
    slot.launching = puppeteer
        .launch({
            executablePath: CHROME_PATH,
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
        })
        .then(b => {
            slot.browser = b;
            slot.launching = undefined;
            b.on("disconnected", () => {
                slot.browser = null;
            });
            return b;
        })
        .catch(err => {
            slot.launching = undefined;
            throw err;
        });
    return slot.launching;
}

export async function renderResumePDF(props: ResumeProps): Promise<Buffer> {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = "<!doctype html>" + renderToStaticMarkup(React.createElement(ResumeDoc, props));
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: "domcontentloaded" });
        await page.emulateMediaType("print");
        const pdf = await page.pdf({
            format: "Letter",
            printBackground: false,
            preferCSSPageSize: false,
            margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
        });
        return Buffer.from(pdf);
    } finally {
        await page.close().catch(() => undefined);
    }
}

export async function shutdownPDFBrowser(): Promise<void> {
    const slot = g.__mcPuppeteer!;
    if (slot.browser) {
        await slot.browser.close().catch(() => undefined);
        slot.browser = null;
    }
}
