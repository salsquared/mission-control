"use client";

import React, { useEffect, useState, useRef } from "react";
import { WidgetGrid, WidgetItem } from "../WidgetGrid";
import { Rocket, Satellite, ThermometerSun, Loader2, Moon } from "lucide-react";
import { NewsCyclingCard } from "../NewsCyclingCard";
import {
    WiMoonNew,
    WiMoonWaxingCrescent3,
    WiMoonFirstQuarter,
    WiMoonWaxingGibbous3,
    WiMoonFull,
    WiMoonWaningGibbous3,
    WiMoonThirdQuarter,
    WiMoonWaningCrescent3
} from "react-icons/wi";

const getMoonIcon = (phase: string) => {
    switch (phase) {
        case "New Moon": return <WiMoonNew className="w-6 h-6" />;
        case "Waxing Crescent": return <WiMoonWaxingCrescent3 className="w-6 h-6" />;
        case "First Quarter": return <WiMoonFirstQuarter className="w-6 h-6" />;
        case "Waxing Gibbous": return <WiMoonWaxingGibbous3 className="w-6 h-6" />;
        case "Full Moon": return <WiMoonFull className="w-6 h-6" />;
        case "Waning Gibbous": return <WiMoonWaningGibbous3 className="w-6 h-6" />;
        case "Last Quarter": return <WiMoonThirdQuarter className="w-6 h-6" />;
        case "Waning Crescent": return <WiMoonWaningCrescent3 className="w-6 h-6" />;
        default: return <WiMoonFull className="w-6 h-6" />;
    }
};

export interface SpaceArticle {
    id: string | number;
    title: string;
    url: string;
    image_url: string;
    news_site: string;
}

export interface Launch {
    id: string;
    name: string;
    net: string;
    status: { id: number; name: string; abbrev: string };
    launch_service_provider?: { name: string };
    pad?: { name: string; location: { name: string } };
    image: string;
}

const NextLaunchTimer: React.FC<{ launch: Launch | null }> = ({ launch }) => {
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

            if (diff <= 0) {
                setTimeUntilLaunch("Launched!");
                return;
            }

            const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);

            let tStr = "T-Minus ";
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
    }, [launch]);

    return <div className="text-3xl font-mono text-white">{timeUntilLaunch}</div>;
};

export const SpaceDashboard: React.FC = () => {
    const [newsBySource, setNewsBySource] = useState<Record<string, SpaceArticle[]>>({});
    const [launches, setLaunches] = useState<Launch[]>([]);
    const [satellitesData, setSatellitesData] = useState<any>(null);
    const [solarData, setSolarData] = useState<any>(null);
    const [moonData, setMoonData] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    const moonScrollRef = useRef<HTMLDivElement>(null);
    const todayRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (moonData && moonScrollRef.current && todayRef.current) {
            const container = moonScrollRef.current;
            const todayItem = todayRef.current;

            const containerWidth = container.clientWidth;
            const containerScrollLeft = container.scrollLeft;

            const itemOffsetLeft = todayItem.offsetLeft;
            const itemWidth = todayItem.clientWidth;

            // If today's item is not fully visible, scroll to it
            if (itemOffsetLeft < containerScrollLeft || (itemOffsetLeft + itemWidth) > (containerScrollLeft + containerWidth)) {
                container.scrollTo({
                    left: itemOffsetLeft - (containerWidth / 2) + (itemWidth / 2),
                    behavior: 'smooth'
                });
            }
        }
    }, [moonData]);

    useEffect(() => {
        Promise.all([
            fetch("/api/space").then(res => res.json()),
            fetch("/api/space/launches").then(res => res.json()),
            fetch("/api/space/satellites").then(res => res.json()),
            fetch("/api/space/solar").then(res => res.json()),
            fetch("/api/space/moon").then(res => res.json())
        ])
            .then(([spaceData, launchData, satsData, solar, moon]) => {
                if (Array.isArray(spaceData)) {
                    // Group articles by their news_site
                    const grouped: Record<string, SpaceArticle[]> = {};
                    spaceData.forEach((article: SpaceArticle) => {
                        const site = article.news_site;
                        if (!grouped[site]) {
                            grouped[site] = [];
                        }
                        grouped[site].push(article);
                    });
                    setNewsBySource(grouped);
                }

                if (Array.isArray(launchData)) {
                    setLaunches(launchData);
                }

                if (satsData && satsData.total_active) {
                    setSatellitesData(satsData);
                }

                if (solar && solar.status) {
                    setSolarData(solar);
                }

                if (moon && moon.weekly_cycles) {
                    setMoonData(moon);
                }

                setLoading(false);
            })
            .catch(err => {
                console.error("Error fetching space dashboard data", err);
                setLoading(false);
            });
    }, []);



    const nextLaunch = launches.length > 0 ? launches[0] : null;

    const staticWidgets: WidgetItem[] = [
        {
            id: "space-1",
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-2 text-cyan-400">
                        <Rocket className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Next Launch</h3>
                    </div>
                    {nextLaunch ? (
                        <div className="flex-1 flex flex-col justify-center py-4">
                            <NextLaunchTimer launch={nextLaunch} />
                            <div className="text-xs text-muted-foreground mt-1 line-clamp-1" title={nextLaunch.name}>
                                {nextLaunch.name}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1 line-clamp-1 opacity-70">
                                {nextLaunch.pad?.location?.name || "Unknown Location"}
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col justify-center py-4 text-muted-foreground text-sm">
                            {loading ? "Loading..." : "No upcoming launches found"}
                        </div>
                    )}
                </div>
            ),
        },
        {
            id: "space-2",
            content: (
                <div className="flex flex-col h-full overflow-y-auto pr-1">
                    <div className="flex items-center gap-2 mb-2 text-purple-400">
                        <Satellite className="w-5 h-5 shrink-0" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Active Sats</h3>
                    </div>
                    {satellitesData ? (
                        <>
                            <div className="text-xl font-bold text-white py-1">TOTAL: {satellitesData.total_active.toLocaleString()}</div>

                            <div className="w-full mt-3 grid grid-cols-5 gap-1.5 text-center h-full">
                                <div className="flex flex-col">
                                    <div className="text-xs text-muted-foreground uppercase font-bold border-b border-white/10 pb-1">LEO</div>
                                    <div className="text-xl text-white font-bold pt-1.5">{satellitesData.orbits.LEO.toLocaleString()}</div>
                                    <div className="text-[9px] text-muted-foreground opacity-80 mt-auto pt-2 leading-tight">160 - 2k km</div>
                                </div>
                                <div className="flex flex-col">
                                    <div className="text-xs text-muted-foreground uppercase font-bold border-b border-white/10 pb-1">MEO</div>
                                    <div className="text-xl text-white font-bold pt-1.5">{satellitesData.orbits.MEO.toLocaleString()}</div>
                                    <div className="text-[9px] text-muted-foreground opacity-80 mt-auto pt-2 leading-tight">2k - 35k km</div>
                                </div>
                                <div className="flex flex-col">
                                    <div className="text-xs text-muted-foreground uppercase font-bold border-b border-white/10 pb-1">GEO</div>
                                    <div className="text-xl text-white font-bold pt-1.5">{satellitesData.orbits.GEO.toLocaleString()}</div>
                                    <div className="text-[9px] text-muted-foreground opacity-80 mt-auto pt-2 leading-tight">35k km</div>
                                </div>
                                <div className="flex flex-col">
                                    <div className="text-xs text-muted-foreground uppercase font-bold border-b border-white/10 pb-1">SSO</div>
                                    <div className="text-xl text-white font-bold pt-1.5">{satellitesData.orbits.SSO.toLocaleString()}</div>
                                    <div className="text-[9px] text-muted-foreground opacity-80 mt-auto pt-2 leading-tight">500 - 1k km</div>
                                </div>
                                <div className="flex flex-col">
                                    <div className="text-xs text-muted-foreground uppercase font-bold border-b border-white/10 pb-1">Other</div>
                                    <div className="text-xl text-white font-bold pt-1.5">{satellitesData.orbits.other?.toLocaleString() || 0}</div>
                                    <div className="text-[9px] text-muted-foreground opacity-80 mt-auto pt-2 leading-tight">Var.</div>
                                </div>
                            </div>

                            <div className="mt-3 pt-2 border-t border-white/10">
                                <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1.5">Mega-Constellations</div>
                                <div className="grid grid-cols-2 gap-2 text-center">
                                    <div className="bg-white/5 rounded p-1.5">
                                        <div className="text-[10px] uppercase font-bold text-purple-400/80">Starlink</div>
                                        <div className="text-base text-white font-bold">{satellitesData.constellations.starlink.toLocaleString()}</div>
                                    </div>
                                    <div className="bg-white/5 rounded p-1.5">
                                        <div className="text-[10px] uppercase font-bold text-blue-400/80">OneWeb</div>
                                        <div className="text-base text-white font-bold">{satellitesData.constellations.oneweb?.toLocaleString() || 0}</div>
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="flex-1 flex flex-col justify-center py-4 text-muted-foreground text-sm">
                            {loading ? "Loading..." : "Data Unavailable"}
                        </div>
                    )}
                </div>
            ),
        },
        {
            id: "space-3",
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-2 text-yellow-400">
                        <ThermometerSun className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Solar Activity</h3>
                    </div>
                    {solarData ? (
                        <>
                            <div className="text-xl font-bold text-white py-2">{solarData.status}</div>
                            <div className="text-xs text-muted-foreground">X-Ray Flux: {solarData.xray_flux}</div>
                        </>
                    ) : (
                        <div className="flex-1 flex flex-col justify-center py-4 text-muted-foreground text-sm">
                            {loading ? "Loading..." : "Data Unavailable"}
                        </div>
                    )}
                </div>
            ),
        },
        {
            id: "space-4",
            content: (
                <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-2 text-slate-300">
                        <Moon className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Lunar Cycle</h3>
                    </div>
                    {moonData ? (
                        <>
                            <div className="text-xl font-bold text-white py-1">
                                {moonData.weekly_cycles.find((d: any) => d.date === new Date().toISOString().split('T')[0])?.phase || moonData.weekly_cycles[7]?.phase}
                            </div>

                            <div ref={moonScrollRef} className="flex gap-2 overflow-x-auto pb-2 mt-2 scrollbar-none relative">
                                {moonData.weekly_cycles.map((day: any) => {
                                    const dateObj = new Date(day.date + 'T00:00:00');
                                    const isToday = day.date === new Date().toISOString().split('T')[0];

                                    return (
                                        <div
                                            key={day.date}
                                            ref={isToday ? todayRef : null}
                                            className={`flex flex-col items-center justify-center rounded px-2 py-1.5 min-w-[50px] shrink-0 ${isToday ? 'bg-cyan-500/20 border border-cyan-500/50' : 'bg-white/5'}`}
                                        >
                                            <div className="text-[10px] text-muted-foreground uppercase">
                                                {dateObj.toLocaleDateString('en-US', { weekday: 'short' })} {dateObj.getDate()}
                                            </div>
                                            <div className="my-1 text-white opacity-90" title={`${day.illumination}% Illuminated`}>
                                                {getMoonIcon(day.phase)}
                                            </div>
                                            <div className="text-[10px] text-muted-foreground mt-0.5">{day.illumination}%</div>
                                        </div>
                                    );
                                })}
                            </div>

                            {moonData.next_phenomenon && (
                                <div className="mt-3 pt-2 border-t border-white/10">
                                    <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Next Event: {moonData.next_phenomenon.type}</div>
                                    <div className="text-sm text-white font-medium">{new Date(moonData.next_phenomenon.date).toLocaleDateString()}</div>
                                    <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{moonData.next_phenomenon.description}</div>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="flex-1 flex flex-col justify-center py-4 text-muted-foreground text-sm">
                            {loading ? "Loading..." : "Data Unavailable"}
                        </div>
                    )}
                </div>
            ),
        },
    ];

    const newsWidgets: WidgetItem[] = loading ? [
        {
            id: "loading-news",
            content: (
                <div className="flex items-center justify-center h-full w-full text-cyan-500 py-8">
                    <Loader2 className="w-8 h-8 animate-spin" />
                </div>
            )
        }
    ] : Object.entries(newsBySource).map(([source, articles], index) => ({
        id: `news-${source}-${index}`,
        content: <NewsCyclingCard source={source} articles={articles} />
    }));

    return (
        <div className="w-full h-full overflow-y-auto pb-8 space-y-6">
            <div>
                <div className="mb-4 px-6">
                    <h2 className="text-2xl font-bold text-white">Space Data</h2>
                    <p className="text-sm text-muted-foreground">Real-time metrics and tracking</p>
                </div>
                <WidgetGrid items={staticWidgets} layout="masonry" />
            </div>

            <div className="mt-8">
                <div className="mb-4 px-6">
                    <h2 className="text-2xl font-bold text-white">Space News</h2>
                    <p className="text-sm text-muted-foreground">Latest headlines from orbit and beyond</p>
                </div>
                <WidgetGrid items={newsWidgets} layout="masonry" />
            </div>
        </div>
    );
};

