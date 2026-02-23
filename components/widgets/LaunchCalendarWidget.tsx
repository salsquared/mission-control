import React, { useMemo } from "react";
import { Launch } from "../views/SpaceView";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";

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

export const LaunchCalendarWidget: React.FC<LaunchCalendarWidgetProps> = ({ launches }) => {
    const today = new Date();
    const [viewDate, setViewDate] = React.useState(new Date(today.getFullYear(), today.getMonth(), 1));

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

        launches.forEach(launch => {
            const date = new Date(launch.net);
            // Only include launches for the current viewed month
            if (date.getFullYear() === year && date.getMonth() === month) {
                const day = date.getDate();
                if (!map.has(day)) {
                    map.set(day, []);
                }
                map.get(day)!.push(launch);
            }
        });

        return map;
    }, [launches, viewDate]);

    return (
        <div className="flex flex-col h-full overflow-y-auto pr-1">
            <div className="flex flex-col gap-3 mb-4">
                <div className="flex justify-between items-center">
                    <h3 className="text-lg font-bold text-white relative flex items-center gap-2">
                        {currentMonthName} <span className="text-muted-foreground font-normal">{currentYear}</span>
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
                                        <div key={launch.id} title={launch.name} className={`text-[10px] w-full px-1.5 py-1 rounded-sm text-white/90 truncate cursor-help ${getRocketColor(launch.name, launch.launch_service_provider?.name)} shadow-sm`}>
                                            <span className="font-semibold">{getRocketLabel(launch.name, launch.launch_service_provider?.name)}</span>{estimatedStr}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
