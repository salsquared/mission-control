"use client";

import React, { useEffect, useRef } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { CardGrid, CardItem } from "../grids/CardGrid";
import { Satellite, ThermometerSun, Loader2, Moon } from "lucide-react";
import { ReloadButton } from "../ui/ReloadButton";
import { NewsCyclingCard } from "../cards/NewsCyclingCard";
import { NextLaunchCard } from "../cards/space/NextLaunchCard";
import { LaunchCalendarWidget } from "../widgets/LaunchCalendarWidget";
import { Calendar } from "lucide-react";
import { Section } from "../Section";
import { Scrollbar } from "../ui/Scrollbar";
import { COMPANIES as COMPANY_REGISTRY } from "../../lib/companies/manifest";
import { fetcher } from "@/lib/fetcher-client";

// All space-view companies from the registry (used for dynamic fetching)
const SPACE_COMPANIES = COMPANY_REGISTRY.filter(c => c.view === 'space');

// Ordered category labels for display grouping
const SPACE_CATEGORIES = [
    'Prime Contractors',
    'Upstart Launch Providers',
    'Space Hardware',
    'Government Agencies',
];

// Unicode moon-phase glyphs (U+1F311 – U+1F318). Native to OS fonts on all
// modern platforms — drops the 83 MB `react-icons` dependency that was only
// being used here. Sized via text classes so they scale with surrounding
// type and inherit color.
const MOON_GLYPHS: Record<string, string> = {
    'New Moon':         '\u{1F311}',
    'Waxing Crescent':  '\u{1F312}',
    'First Quarter':    '\u{1F313}',
    'Waxing Gibbous':   '\u{1F314}',
    'Full Moon':        '\u{1F315}',
    'Waning Gibbous':   '\u{1F316}',
    'Last Quarter':     '\u{1F317}',
    'Waning Crescent':  '\u{1F318}',
};

const getMoonIcon = (phase: string) => (
    <span className="text-2xl leading-none select-none" aria-label={phase}>
        {MOON_GLYPHS[phase] ?? MOON_GLYPHS['Full Moon']}
    </span>
);

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

function useSpaceCompanyNews(companies: typeof SPACE_COMPANIES) {
    const results = useQueries({
        queries: companies.map(c => ({
            queryKey: ['company-news', c.id],
            queryFn: () => fetcher<SpaceArticle[]>(`/api/company-news?company=${c.id}`),
        })),
    });
    const newsMap: Record<string, SpaceArticle[]> = {};
    companies.forEach((c, i) => {
        const data = results[i].data;
        if (Array.isArray(data) && data.length > 0) newsMap[c.name] = data;
    });
    return { newsMap };
}

export const SpaceView: React.FC = () => {
    const { data: spaceNewsRaw, refetch: refetchSpace } = useQuery<SpaceArticle[]>({ queryKey: ['space', 'news'], queryFn: () => fetcher('/api/space') });
    const { data: launchData, refetch: refetchLaunches } = useQuery<Launch[]>({ queryKey: ['space', 'launches'], queryFn: () => fetcher('/api/space/launches') });
    const { data: satellitesData, refetch: refetchSats } = useQuery<any>({
        queryKey: ['space', 'satellites'],
        queryFn: () => fetcher('/api/space/satellites'),
        // Celestrak's gp.php 403s when their GROUP=active data hasn't changed
        // since our last successful pull (per-IP, 2h cadence). Retrying multiplies
        // the lockout — react-query default of 3 retries means 4× the hits per mount.
        retry: false,
    });
    const { data: solarData, refetch: refetchSolar } = useQuery<any>({ queryKey: ['space', 'solar'], queryFn: () => fetcher('/api/space/solar') });
    const { data: moonData, refetch: refetchMoon } = useQuery<any>({ queryKey: ['space', 'moon'], queryFn: () => fetcher('/api/space/moon') });
    const { newsMap: companyNewsMap } = useSpaceCompanyNews(SPACE_COMPANIES);

    const launches: Launch[] = Array.isArray(launchData) ? launchData : [];
    const loading = !spaceNewsRaw && !launchData;

    // Build newsBySource: general space news + company news
    const newsBySource: Record<string, SpaceArticle[]> = {};
    if (Array.isArray(spaceNewsRaw)) {
        spaceNewsRaw.forEach((article) => {
            const site = article.news_site;
            if (!newsBySource[site]) newsBySource[site] = [];
            newsBySource[site].push(article);
        });
    }
    Object.assign(newsBySource, companyNewsMap);

    const reloadNews = () => { refetchSpace(); };
    const reloadLaunches = () => { refetchLaunches(); };
    const reloadSats = () => { refetchSats(); };
    const reloadSolar = () => { refetchSolar(); };
    const reloadMoon = () => { refetchMoon(); };

    const moonScrollRef = useRef<HTMLDivElement>(null);
    const todayRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (moonData && moonScrollRef.current && todayRef.current) {
            // scroll to today in the lunar calendar
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


    const staticCards: CardItem[] = [
        {
            id: "space-launch-info",
            hFit: true,
            content: <NextLaunchCard launches={launches} loading={loading} onReload={reloadLaunches} />
        },
        {
            id: "space-calendar",
            colSpan: 2,
            rowSpan: 2,
            content: (
                <div className="flex flex-col overflow-y-auto custom-scrollbar pr-1">
                    <div className="flex items-center justify-between mb-2 text-blue-400">
                        <div className="flex items-center gap-2">
                            <Calendar className="w-5 h-5 shrink-0" />
                            <h3 className="font-bold tracking-wider uppercase text-sm">Launch Calendar</h3>
                        </div>
                        <ReloadButton onReload={reloadLaunches} title="Reload Calendar" />
                    </div>
                    <LaunchCalendarWidget launches={launches} />
                </div>
            )
        },
        {
            id: "space-2",
            hFit: true,
            content: (
                <div className="flex flex-col overflow-y-auto custom-scrollbar pr-1">
                    <div className="flex items-center justify-between mb-2 text-purple-400">
                        <div className="flex items-center gap-2">
                            <Satellite className="w-5 h-5 shrink-0" />
                            <h3 className="font-bold tracking-wider uppercase text-sm">Active Sats</h3>
                        </div>
                        <ReloadButton onReload={reloadSats} title="Reload Active Sats" />
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
                    <div className="flex items-center justify-between mb-2 text-yellow-400">
                        <div className="flex items-center gap-2">
                            <ThermometerSun className="w-5 h-5" />
                            <h3 className="font-bold tracking-wider uppercase text-sm">Solar Activity</h3>
                        </div>
                        <ReloadButton onReload={reloadSolar} title="Reload Solar Activity" />
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
                    <div className="flex items-center justify-between mb-2 text-slate-300">
                        <div className="flex items-center gap-2">
                            <Moon className="w-5 h-5" />
                            <h3 className="font-bold tracking-wider uppercase text-sm">Lunar Cycle</h3>
                        </div>
                        <ReloadButton onReload={reloadMoon} title="Reload Lunar Cycle" />
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

                            <div ref={moonScrollRef} className="flex gap-2 overflow-x-auto pb-2 mt-2 scrollbar-none relative touch-pan-x">
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

    const buildCompanyGroups = () => {
        if (loading) return [];

        const groups: { label: string; items: CardItem[] }[] = [];

        for (const category of SPACE_CATEGORIES) {
            const companiesInCategory = SPACE_COMPANIES.filter(c => c.category === category);
            const categoryCards: CardItem[] = [];

            for (const company of companiesInCategory) {
                const articles = newsBySource[company.name];
                if (articles && articles.length > 0) {
                    categoryCards.push({
                        id: `news-${company.id}`,
                        content: <NewsCyclingCard source={company.name} articles={articles} />
                    });
                }
            }

            if (categoryCards.length > 0) {
                groups.push({ label: category, items: categoryCards });
            }
        }

        return groups;
    };

    // Build general space news outlet cards (from SNAPI aggregator, not company-specific)
    const buildOutletCards = (): CardItem[] => {
        if (loading) {
            return [{
                id: "loading-news",
                content: (
                    <div className="flex items-center justify-center h-full w-full text-cyan-500 py-8">
                        <Loader2 className="w-8 h-8 animate-spin" />
                    </div>
                )
            }];
        }

        const companyNames = new Set(SPACE_COMPANIES.map(c => c.name));
        return Object.entries(newsBySource)
            .filter(([source]) => !companyNames.has(source))
            .map(([source, articles]) => ({
                id: `news-outlet-${source}`,
                content: <NewsCyclingCard source={source} articles={articles} />
            }));
    };

    const companyGroups = buildCompanyGroups();
    const outletCards = buildOutletCards();

    return (
        <Scrollbar className="w-full h-full pb-8 space-y-6">
            <Section title="Space Data" description="Real-time metrics and tracking">
                <CardGrid items={staticCards} layout="grid" className="grid-flow-row-dense" />
            </Section>

            <Section
                title="Company News"
                description="Direct feeds from space companies"
                groups={companyGroups}
            />

            <Section title="Space News" description="Latest headlines from orbit and beyond">
                <CardGrid items={outletCards} layout="masonry" />
            </Section>
        </Scrollbar>
    );
};
