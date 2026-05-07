import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { findUserByEmail } from "@/lib/repositories/users";
import { findGmailWatch } from "@/lib/repositories/gmail-watches";
import { installGmailWatch } from "@/lib/gmail-watch";

// googleapis pulls in node:* — the edge runtime can't load it.
export const runtime = 'nodejs';

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = await findUserByEmail(session.user.email);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const watch = await findGmailWatch(user.id);
    return NextResponse.json({ watch }, { status: 200 });
}

export async function POST() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = await findUserByEmail(session.user.email);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    try {
        const watch = await installGmailWatch(user.id);
        return NextResponse.json({ watch }, { status: 200 });
    } catch (e: any) {
        console.error("[GMAIL WATCH] install failed:", e.message);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
