import React, { useState } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Section } from "../Section";
import { Loader2, Mail } from "lucide-react";
import { useSession, signIn } from "next-auth/react";

export const ApplicationsView: React.FC = () => {
    const { data: session, status } = useSession();
    const [loading, setLoading] = useState(false);

    const applicationsCards: CardItem[] = status === "loading" || loading ? [
        {
            id: "loading-applications",
            colSpan: 3,
            content: (
                <div className="flex items-center justify-center py-8 text-blue-500">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : [
        {
            id: "applications-overview",
            colSpan: 3,
            content: (
                <div className="p-6 bg-slate-800 rounded-xl h-full border border-slate-700">
                    <h3 className="text-xl font-semibold mb-2">My Applications</h3>
                    <p className="text-slate-400">Track jobs, internships, schools, and citizenship applications.</p>
                    
                    {session ? (
                        <div className="mt-6">
                            <div className="flex items-center gap-3 p-4 bg-slate-900/50 rounded-lg border border-slate-700/50">
                                {session.user?.image && (
                                    <img src={session.user.image} alt="Avatar" className="w-10 h-10 rounded-full" />
                                )}
                                <div>
                                    <p className="font-medium text-slate-200">Connected as {session.user?.name}</p>
                                    <p className="text-sm text-slate-500">{session.user?.email}</p>
                                </div>
                            </div>
                            <div className="mt-6 text-sm text-slate-500">
                                {/* Placeholder for parsed applications */}
                                Automatically scanning connected Gmail for applications...
                            </div>
                        </div>
                    ) : (
                        <div className="mt-6 flex flex-col items-start gap-4">
                            <p className="text-sm text-slate-400">Connect your Google account to automatically import and track applications from Gmail.</p>
                            <button
                                onClick={() => signIn("google")}
                                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors font-medium shadow-lg shadow-blue-500/20"
                            >
                                <Mail className="w-4 h-4" />
                                Connect Gmail
                            </button>
                        </div>
                    )}
                </div>
            )
        }
    ];

    return (
        <div className="w-full h-full overflow-y-auto pb-8 relative">
            <Section title="Applications" description="Track and manage your applications">
                <CardGrid items={applicationsCards} layout="grid" />
            </Section>
        </div>
    );
};
