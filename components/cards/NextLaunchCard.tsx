import React, { useEffect, useState } from "react";
import { Rocket } from "lucide-react";
import { Launch } from "../views/SpaceView";

const NextLaunchTimer: React.FC<{ launch: Launch | null; onExpire: () => void }> = ({ launch, onExpire }) => {
    const [timeUntilLaunch, setTimeUntilLaunch] = useState<string>("Calculating...");

    useEffect(() => {
        if (!launch) {
            setTimeUntilLaunch("Calculating...");
            return;
        }

        const nextLaunchNet = new Date(launch.net).getTime();

        const updateTimer = () => {
            const now = new Date().getTime();
            const diff = nextLaunchNet - now;

            if (diff <= -60000) {
                onExpire();
                return;
            }

            if (diff <= 0) {
                setTimeUntilLaunch("Launched!");
                return;
            }

            const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);

            let tStr = "T-";
            if (diff >= 1000 * 60 * 60 * 24) {
                const d = Math.floor(diff / (1000 * 60 * 60 * 24));
                tStr += `${d}d `;
            }
            tStr += `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            setTimeUntilLaunch(tStr);
        };

        updateTimer(); // Initial call
        const interval = setInterval(updateTimer, 1000);

        return () => clearInterval(interval);
    }, [launch, onExpire]);

    return <div className="text-3xl font-mono text-white">{timeUntilLaunch}</div>;
};

interface NextLaunchCardProps {
    launches: Launch[];
    loading: boolean;
}

export const NextLaunchCard: React.FC<NextLaunchCardProps> = ({ launches, loading }) => {
    const [, setExpireCount] = useState(0);

    const activeLaunches = launches.filter(l => new Date(l.net).getTime() > Date.now() - 60000);
    const nextLaunch = activeLaunches.length > 0 ? activeLaunches[0] : null;

    const nextFalcon9 = activeLaunches.find(l => l.name.includes("Falcon 9"));
    const nextStarship = activeLaunches.find(l => l.name.includes("Starship"));
    const nextNeutron = activeLaunches.find(l => l.name.includes("Neutron"));
    const nextVulcan = activeLaunches.find(l => l.name.includes("Vulcan"));

    const upcomingHighlights = [
        { label: "Falcon 9", launch: nextFalcon9 },
        { label: "Starship", launch: nextStarship },
        { label: "Neutron", launch: nextNeutron },
        { label: "Vulcan", launch: nextVulcan }
    ];

    return (
        <div className="flex flex-col pr-1">
            <div className="flex items-center gap-2 mb-2 text-cyan-400">
                <Rocket className="w-5 h-5 shrink-0" />
                <h3 className="font-bold tracking-wider uppercase text-sm">Next Launch</h3>
            </div>
            {nextLaunch ? (
                <div className="flex flex-row w-full">
                    <div className="w-1/2 flex flex-col justify-center py-4 pr-4">
                        <NextLaunchTimer launch={nextLaunch} onExpire={() => setExpireCount(c => c + 1)} />
                        <div className="text-xs text-muted-foreground mt-2 line-clamp-2" title={nextLaunch.name}>
                            {nextLaunch.name}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 line-clamp-1 opacity-70">
                            {nextLaunch.pad?.location?.name || "Unknown Location"}
                        </div>
                    </div>
                    <div className="w-1/2 flex flex-col justify-center pl-4 py-4 border-l border-white/10">
                        <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1.5">Upcoming Highlights</div>
                        <div className="flex flex-col gap-1.5">
                            {upcomingHighlights.map(h => {
                                let dateDisplay = 'TBA';
                                let tooltipText = h.launch?.name || 'To Be Announced';

                                if (h.launch) {
                                    const isTBD = h.launch.status.abbrev === 'TBD';
                                    const d = new Date(h.launch.net);
                                    dateDisplay = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

                                    if (isTBD) {
                                        dateDisplay = `NET ${dateDisplay}`;
                                        tooltipText = `${h.launch.name} (Estimated)`;
                                    }
                                }

                                return (
                                    <div key={h.label} className="flex justify-between items-center text-xs">
                                        <span className="text-white font-medium">{h.label}</span>
                                        <span className="text-muted-foreground truncate ml-2" title={tooltipText}>
                                            {dateDisplay}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="flex-1 flex flex-col justify-center py-4 text-muted-foreground text-sm">
                    {loading ? "Loading..." : "No upcoming launches found"}
                </div>
            )}
        </div>
    );
};
