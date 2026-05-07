import React from "react";

const PIPELINE_ORDER = ["APPLIED", "ASSESSMENT", "INTERVIEW", "OFFER"] as const;
const STEP_LABELS: Record<(typeof PIPELINE_ORDER)[number], string> = {
    APPLIED: "Applied",
    ASSESSMENT: "Assess",
    INTERVIEW: "Interview",
    OFFER: "Offer",
};

// Map every status the parser emits onto a forward index in the pipeline.
function pipelineIndex(status: string): number {
    switch (status) {
        case "APPLIED":
        case "UPDATED":
            return 0;
        case "ASSESSMENT":
            return 1;
        case "INTERVIEW_REQUESTED":
        case "INTERVIEW":
            return 2;
        case "OFFER":
            return 3;
        default:
            return 0;
    }
}

interface Props {
    status: string;
}

export const ApplicationStepper: React.FC<Props> = ({ status }) => {
    if (status === "REJECTED") {
        return (
            <div className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold text-rose-400/90">
                <span className="h-px w-3 bg-rose-400/60" />
                Rejected
            </div>
        );
    }

    const reached = pipelineIndex(status);

    return (
        <div className="mt-3 flex items-center gap-1">
            {PIPELINE_ORDER.map((step, i) => {
                const isReached = i <= reached;
                const isCurrent = i === reached;
                return (
                    <React.Fragment key={step}>
                        <div className="flex flex-col items-center gap-1 min-w-0 flex-1">
                            <div
                                className={[
                                    "h-1 w-full rounded-full transition-colors",
                                    isReached ? "bg-blue-400/80" : "bg-white/10",
                                    isCurrent ? "shadow-[0_0_6px_rgba(96,165,250,0.6)]" : "",
                                ].join(" ")}
                            />
                            <span
                                className={[
                                    "text-[9px] uppercase tracking-wider font-semibold truncate",
                                    isReached ? "text-slate-200" : "text-slate-500",
                                ].join(" ")}
                            >
                                {STEP_LABELS[step]}
                            </span>
                        </div>
                    </React.Fragment>
                );
            })}
        </div>
    );
};
