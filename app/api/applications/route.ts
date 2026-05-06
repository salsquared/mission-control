import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { findUserByEmail } from "@/lib/repositories/users";
import { findApplicationsByUser } from "@/lib/repositories/applications";

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await findUserByEmail(session.user.email);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const applications = await findApplicationsByUser(user.id);

    return NextResponse.json({ applications }, { status: 200 });
  } catch (error: any) {
    console.error("Error fetching applications:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
