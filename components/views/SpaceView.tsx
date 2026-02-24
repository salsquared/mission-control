"use client";

import React, { useEffect, useState, useRef } from "react";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Rocket, Satellite, ThermometerSun, Loader2, Moon } from "lucide-react";
import { NewsCyclingCard } from "../cards/NewsCyclingCard";
import { NextLaunchCard } from "../cards/NextLaunchCard";
import { LaunchCalendarWidget } from "../widgets/LaunchCalendarWidget";
import { Calendar } from "lucide-react";
import { Section } from "../Section";

// (Previous imports and helper functions remain exactly the same...)
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

export const SpaceView: React.FC = () => {
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
            fetch("/api/space?bust=2").then(res => res.json()),
            fetch("/api/space/launches?bust=2").then(res => res.json()),
            fetch("/api/space/satellites?bust=2").then(res => res.json()),
            fetch("/api/space/solar?bust=2").then(res => res.json()),
            fetch("/api/space/moon?bust=2").then(res => res.json())
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

    const staticCards: CardItem[] = [
        {
            id: "space-launch-info",
            hFit: true,
            content: <NextLaunchCard launches={launches} loading={loading} />
        },
        {
            id: "space-calendar",
            colSpan: 2,
            rowSpan: 2,
            content: (
                <div className="flex flex-col overflow-y-auto pr-1">
                    <div className="flex items-center gap-2 mb-2 text-blue-400">
                        <Calendar className="w-5 h-5 shrink-0" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Launch Calendar</h3>
                    </div>
                    <LaunchCalendarWidget launches={launches} />
                </div>
            )
        },
        {
            id: "space-2",
            hFit: true,
            content: (
                <div className="flex flex-col overflow-y-auto pr-1">
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
            hFit: true,
            content: (
                <div className="flex flex-col">
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
            hFit: true,
            content: (
                <div className="flex flex-col">
                    <div className="flex items-center gap-2 mb-2 text-slate-300">
                        <Moon className="w-5 h-5" />
                        <h3 className="font-bold tracking-wider uppercase text-sm">Lunar Cycle</h3>
                    </div>
                    {moonData ? (
                        <>
                            <div className="text-xl font-bold text-white py-1">
                                {moonData.weekly_cycles.find((d: any) => {
                                    const now = new Date();
                                    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                                    return d.date === todayStr;
                                })?.phase || moonData.weekly_cycles[7]?.phase}
                            </div>

                            <div ref={moonScrollRef} className="flex gap-2 overflow-x-auto pb-2 mt-2 scrollbar-none relative">
                                {moonData.weekly_cycles.map((day: any) => {
                                    const dateObj = new Date(day.date + 'T00:00:00');
                                    const now = new Date();
                                    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                                    const isToday = day.date === todayStr;

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

    const newsCards: CardItem[] = loading ? [
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
            <Section title="Space Data" description="Real-time metrics and tracking">
                <CardGrid items={staticCards} layout="grid" className="grid-flow-row-dense" />
            </Section>

            <Section title="Space News" description="Latest headlines from orbit and beyond">
                <CardGrid items={newsCards} layout="masonry" />
            </Section>
        </div>
    );
};

