import { buildBulletAssistPrompt, type SiblingInput } from "@/lib/profile/bullet-assist";
import type { ArchiveSpan } from "@/lib/profile/upload-archive";

const hugeSiblings: SiblingInput[] = Array.from({ length: 50 }, (_, i) => ({
    text: `Sibling bullet ${i}: ${'pad '.repeat(40)}`,
    tags: ['typescript'],
}));
const hugeSpans: ArchiveSpan[] = Array.from({ length: 3 }, (_, i) => ({
    uploadId: `u_${i}`,
    filename: `r${i}.pdf`,
    uploadedAt: new Date(Date.UTC(2024, i, 1)),
    span: 'x'.repeat(4_000),
}));
const hugeReadme = {
    projectId: 'p_1',
    projectName: 'Pulsar',
    excerpt: 'y'.repeat(10_000),
};

async function main() {
    const result = await buildBulletAssistPrompt({
        mode: 'fill',
        parent: { kind: 'work-role', id: 'wr_1', company: 'Acme', title: 'Engineer' },
        siblingBullets: hugeSiblings,
        archiveSpans: hugeSpans,
        readmeContext: hugeReadme,
        currentBullet: null,
    });
    console.log("user bytes:", Buffer.byteLength(result.user, 'utf8'));
    console.log("contains '## Entry':", result.user.includes('## Entry'));
    console.log("contains '## Output schema':", result.user.includes('## Output schema'));
    console.log("under 8192 cap:", Buffer.byteLength(result.user, 'utf8') <= 8192);
}
main().catch(e => { console.error(e); process.exit(1); });
