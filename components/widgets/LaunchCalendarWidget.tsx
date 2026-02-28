/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element */
import React, { useMemo, useState, useEffect } from "react";
import { Launch } from "../views/SpaceView";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";

interface LaunchCalendarWidgetProps {
    launches: Launch[];
}

const getRocketColor = (name: string, provider?: string) => {
    const lowerName = name.toLowerCase();
    const lowerProvider = provider ? provider.toLowerCase() : "";

    if (lowerName.includes("falcon")) return "bg-blue-500";
    if (lowerName.includes("starship")) return "bg-green-500";
    if (lowerName.includes("sls") || lowerName.includes("space launch system")) return "bg-orange-500";
    if (lowerName.includes("neutron")) return "bg-yellow-500";
    if (lowerName.includes("electron")) return "bg-cyan-500";
    if (lowerName.includes("vulcan")) return "bg-red-500";

    // Russian
    if (lowerName.includes("soyuz") || lowerName.includes("progress") || lowerName.includes("proton") || lowerName.includes("angara") || lowerProvider.includes("roscosmos")) return "bg-amber-600";

    // European
    if (lowerName.includes("ariane") || lowerName.includes("vega") || lowerProvider.includes("esa") || lowerProvider.includes("arianespace")) return "bg-indigo-500";

    return "bg-gray-500";
};

const getRocketLabel = (name: string, provider?: string) => {
    const lowerName = name.toLowerCase();
    const lowerProvider = provider ? provider.toLowerCase() : "";

    if (lowerName.includes("falcon")) return "Falcon 9";
    if (lowerName.includes("starship")) return "Starship";
    if (lowerName.includes("sls") || lowerName.includes("space launch system")) return "SLS";
    if (lowerName.includes("neutron")) return "Neutron";
    if (lowerName.includes("electron")) return "Electron";
    if (lowerName.includes("vulcan")) return "Vulcan";

    // Russian
    if (lowerName.includes("soyuz") || lowerName.includes("progress") || lowerName.includes("proton") || lowerName.includes("angara") || lowerProvider.includes("roscosmos")) return "Roscosmos";

    // European
    if (lowerName.includes("ariane") || lowerName.includes("vega") || lowerProvider.includes("esa") || lowerProvider.includes("arianespace")) return "ESA";

    // For other rockets, extract the first meaningful part of the name
    return name.split(" | ")[0].split(" ")[0] || name;
};

const getLaunchStatusInfo = (launch: Launch) => {
    const launchTime = new Date(launch.net).getTime();
    const now = new Date().getTime();
    const isPastLaunch = now >= launchTime;

    if (launch.status.abbrev === 'Success') {
        return { name: 'Successfully Launched', colorClass: 'border-green-500/50 text-green-400 bg-green-500/10' };
    }
    if (launch.status.abbrev === 'Failure') {
        return { name: 'Failure', colorClass: 'border-red-500/50 text-red-400 bg-red-500/10' };
    }
    if (launch.status.abbrev === 'Partial Failure') {
        return { name: 'Partial Failure', colorClass: 'border-orange-500/50 text-orange-400 bg-orange-500/10' };
    }
    if (launch.status.abbrev === 'In Flight') {
        return { name: 'In Progress', colorClass: 'border-yellow-500/50 text-yellow-400 bg-yellow-500/10' };
    }

    // If it's past launch time and not explicitly success/failure, guess it's still currently in progress
    if (isPastLaunch) {
        return { name: 'In Progress', colorClass: 'border-yellow-500/50 text-yellow-400 bg-yellow-500/10' };
    }

    // Otherwise, upcoming
    return { name: launch.status.name, colorClass: 'border-blue-500/50 text-blue-400 bg-blue-500/10' };
};

export const LaunchCalendarWidget: React.FC<LaunchCalendarWidgetProps> = ({ launches }) => {
    const today = new Date();
    const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
    const [allLaunches, setAllLaunches] = useState<Launch[]>(launches);
    const [fetchedMonths, setFetchedMonths] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(false);
    const [selectedLaunch, setSelectedLaunch] = useState<Launch | null>(null);

    // Wait for the component to receive potentially updated upcoming launches and merge them
    useEffect(() => {
        if (launches.length > 0) {
            setAllLaunches(prev => {
                const currentIds = new Set(prev.map(l => l.id));
                const newLaunches = launches.filter(l => !currentIds.has(l.id));
                if (newLaunches.length === 0) return prev;
                return [...prev, ...newLaunches];
            });
        }
    }, [launches]);

    useEffect(() => {
        const year = viewDate.getFullYear();
        const month = viewDate.getMonth() + 1; // 1-indexed
        const monthKey = `${year}-${month}`;

        if (fetchedMonths.has(monthKey)) return;

        setIsLoading(true);
        fetch(`/api/space/launches?year=${year}&month=${month}`)
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setAllLaunches(prev => {
                        // Merge launches, avoiding duplicates by ID
                        const currentIds = new Set(prev.map(l => l.id));
                        const newLaunches = data.filter(l => !currentIds.has(l.id));
                        return [...prev, ...newLaunches];
                    });
                }
                setFetchedMonths(prev => new Set(prev).add(monthKey));
                setIsLoading(false);
            })
            .catch(err => {
                console.error("Failed to fetch historical launches for widget:", err);
                setIsLoading(false);
            });
    }, [viewDate, fetchedMonths]);

    const handlePrevMonth = () => {
        setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
    };

    const handleNextMonth = () => {
        setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
    };

    const { daysInMonth, emptyDaysAtStart, currentMonthName, currentYear } = useMemo(() => {
        const year = viewDate.getFullYear();
        const month = viewDate.getMonth();

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);

        return {
            daysInMonth: lastDay.getDate(),
            emptyDaysAtStart: firstDay.getDay(),
            currentMonthName: firstDay.toLocaleString('default', { month: 'long' }),
            currentYear: year,
        };
    }, [viewDate]);

    // Map days to their launches
    const launchesByDay = useMemo(() => {
        const map = new Map<number, Launch[]>();
        const year = viewDate.getFullYear();
        const month = viewDate.getMonth();

        allLaunches.forEach(launch => {
            const date = new Date(launch.net);
            // Only include launches for the current viewed month
            if (date.getFullYear() === year && date.getMonth() === month) {
                const day = date.getDate();

                // Look for 'faux' launch dates (API month dump). 
                // They usually cluster at the end of the month, are marked as TBD, and default to exactly midnight UTC.
                const isMidnightUTC = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
                const isEndOfMonth = day >= 28; // Handles Feb and other months

                // Filter these placeholders out so they don't clog up the end of the month
                if (launch.status.abbrev === 'TBD' && isMidnightUTC && isEndOfMonth) {
                    return; // Skip adding this to the calendar day
                }

                if (!map.has(day)) {
                    map.set(day, []);
                }
                map.get(day)!.push(launch);
            }
        });

        // Sort launches by time within each day
        map.forEach((dayLaunches) => {
            dayLaunches.sort((a, b) => new Date(a.net).getTime() - new Date(b.net).getTime());
        });

        return map;
    }, [allLaunches, viewDate]);

    return (
        <div className="flex flex-col h-full overflow-y-auto pr-1">
            <div className="flex flex-col gap-3 mb-4">
                <div className="flex justify-between items-center">
                    <h3 className="text-lg font-bold text-white relative flex items-center gap-2">
                        {currentMonthName} <span className="text-muted-foreground font-normal">{currentYear}</span>
                        {isLoading && <Loader2 className="w-4 h-4 text-cyan-500 animate-spin ml-1" />}
                    </h3>
                    <div className="flex items-center gap-1 bg-white/5 rounded-full p-1 border border-white/10">
                        <button onClick={handlePrevMonth} className="p-1 hover:bg-white/10 rounded-full transition-colors text-muted-foreground hover:text-white" title="Previous Month">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button onClick={handleNextMonth} className="p-1 hover:bg-white/10 rounded-full transition-colors text-muted-foreground hover:text-white" title="Next Month">
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div className="flex flex-wrap gap-3 text-[10px] md:text-xs bg-white/5 rounded p-2">
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-blue-500"></div><span className="text-muted-foreground">Falcon</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-green-500"></div><span className="text-muted-foreground">Starship</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-orange-500"></div><span className="text-muted-foreground">SLS</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-yellow-500"></div><span className="text-muted-foreground">Neutron</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-cyan-500"></div><span className="text-muted-foreground">Electron</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-red-500"></div><span className="text-muted-foreground">Vulcan</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-amber-600"></div><span className="text-muted-foreground">Roscosmos</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-indigo-500"></div><span className="text-muted-foreground">ESA</span></div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-gray-500"></div><span className="text-muted-foreground">Other</span></div>
                </div>
            </div>

            <div className="grid grid-cols-7 gap-2">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                    <div key={day} className="text-center text-xs font-bold text-muted-foreground uppercase py-2">
                        {day}
                    </div>
                ))}

                {Array.from({ length: emptyDaysAtStart }).map((_, i) => (
                    <div key={`empty-${i}`} className="h-24 rounded-md bg-white/5 opacity-30" />
                ))}

                {Array.from({ length: daysInMonth }).map((_, i) => {
                    const day = i + 1;
                    const dayLaunches = launchesByDay.get(day) || [];
                    const isToday = day === today.getDate() && viewDate.getMonth() === today.getMonth() && viewDate.getFullYear() === today.getFullYear();

                    return (
                        <div key={day} className={`h-24 rounded-md p-2 flex flex-col items-start justify-start overflow-hidden transition-all ${isToday ? 'bg-cyan-500/10 border border-cyan-500/50' : 'bg-white/5 hover:bg-white/10'}`}>
                            <span className={`text-xs font-medium mb-1 ${isToday ? 'text-cyan-400' : 'text-white/70'}`}>{day}</span>
                            <div className="flex flex-col gap-1 w-full overflow-y-auto scrollbar-none">
                                {dayLaunches.map(launch => {
                                    const isTBD = launch.status.abbrev === 'TBD';
                                    const estimatedStr = isTBD ? ' (NET)' : '';
                                    return (
                                        <div
                                            key={launch.id}
                                            title={`${launch.name}\nProvider: ${launch.launch_service_provider?.name || 'Unknown'}\nDate: ${new Date(launch.net).toLocaleString()}`}
                                            onClick={() => setSelectedLaunch(launch)}
                                            className={`text-[10px] w-full px-1.5 py-1 rounded-sm text-white/90 truncate cursor-pointer hover:brightness-110 active:scale-95 transition-all ${getRocketColor(launch.name, launch.launch_service_provider?.name)} shadow-sm`}
                                        >
                                            <span className="font-semibold">{getRocketLabel(launch.name, launch.launch_service_provider?.name)}</span>{estimatedStr}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
            <AnimatePresence>
                {selectedLaunch && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
                        onClick={() => setSelectedLaunch(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0, y: 20 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.95, opacity: 0, y: 20 }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-zinc-900 border border-white/10 rounded-xl overflow-hidden w-full max-w-md shadow-2xl relative"
                        >
                            {selectedLaunch.image && (
                                <div className="w-full h-48 relative border-b border-white/10">
                                    <img src={selectedLaunch.image} alt={selectedLaunch.name} className="w-full h-full object-cover" />
                                    <div className="absolute inset-0 bg-gradient-to-t from-zinc-900 to-transparent" />
                                </div>
                            )}
                            <button
                                onClick={() => setSelectedLaunch(null)}
                                className="absolute top-4 right-4 p-1.5 bg-black/50 hover:bg-black/80 text-white rounded-full transition-colors z-10 backdrop-blur-md"
                            >
                                <X className="w-5 h-5" />
                            </button>
                            <div className="p-5 flex flex-col gap-4">
                                <div>
                                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded text-white shadow-sm ${getRocketColor(selectedLaunch.name, selectedLaunch.launch_service_provider?.name)}`}>
                                            {selectedLaunch.launch_service_provider?.name || 'Unknown Provider'}
                                        </span>
                                        {(() => {
                                            const statusInfo = getLaunchStatusInfo(selectedLaunch);
                                            return (
                                                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${statusInfo.colorClass}`}>
                                                    {statusInfo.name}
                                                </span>
                                            );
                                        })()}
                                    </div>
                                    <h2 className="text-xl font-bold text-white leading-tight">{selectedLaunch.name}</h2>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div className="bg-white/5 p-3 rounded-lg border border-white/10">
                                        <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Launch Date</div>
                                        <div className="text-sm text-white font-medium">{new Date(selectedLaunch.net).toLocaleString()}</div>
                                    </div>
                                    <div className="bg-white/5 p-3 rounded-lg border border-white/10">
                                        <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Location</div>
                                        <div className="text-sm text-white font-medium line-clamp-2" title={selectedLaunch.pad?.location?.name || 'Unknown'}>
                                            {selectedLaunch.pad?.location?.name || 'Unknown'}
                                        </div>
                                    </div>
                                </div>

                                {selectedLaunch.pad?.name && (
                                    <div className="bg-white/5 p-3 rounded-lg border border-white/10">
                                        <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Pad</div>
                                        <div className="text-sm text-white font-medium">{selectedLaunch.pad.name}</div>
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
