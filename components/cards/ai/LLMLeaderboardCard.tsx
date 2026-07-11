"use client";

import React, { useState, useMemo, useEffect } from "react";
import { Trophy, ArrowUpDown, ArrowUp, ArrowDown, Info } from "lucide-react";
import { ReloadButton } from "../../ui/ReloadButton";
import { Card } from "../../ui/Card";

// Payload shape of /api/ai/llmleaderboard — the parser's output crossing the
// JSON boundary. Type-only import, so cheerio never enters the client bundle.
import type { LeaderboardModel } from "@/lib/ai/lmarena-leaderboard";
import { orgSlug } from "@/lib/ai/org-slug";

export type LLMModelInfo = LeaderboardModel;

// P1.3 (OQ3b): org logos are local assets only — the API no longer ships
// scraped SVG markup (it was injected via dangerouslySetInnerHTML, an XSS
// vector). These are curated static files in public/logos/ (one-time
// extracted + sanitized 2026-07-11: no scripts/handlers/external refs,
// rendered via <img> so nothing executes). Keys must match the exact
// orgName strings the API emits; anything unmapped falls back to an
// initials badge.
export const ORG_LOGOS: Record<string, string> = {
    '01.AI': '/logos/01-ai.svg',
    'Ai2': '/logos/ai2.svg',
    'Alibaba': '/logos/alibaba.svg',
    'Alibaba-ATH': '/logos/alibaba-ath.svg',
    'Amazon': '/logos/amazon.svg',
    'Ant Group': '/logos/ant-group.svg',
    'Anthropic': '/logos/anthropic.svg',
    'Arcee AI': '/logos/arcee-ai.svg',
    'Baidu': '/logos/baidu.svg',
    'Bytedance': '/logos/bytedance.svg',
    'Cohere': '/logos/cohere.svg',
    'DeepSeek': '/logos/deepseek.svg',
    'Diffbot': '/logos/diffbot.svg',
    'Flux': '/logos/flux.svg',
    'Genmo AI': '/logos/genmo-ai.svg',
    'Google': '/logos/google.svg',
    'HiDream': '/logos/hidream.svg',
    'IBM': '/logos/ibm.svg',
    'Ideogram': '/logos/ideogram.svg',
    'Inception AI': '/logos/inception-ai.svg',
    'Kandinsky': '/logos/kandinsky.svg',
    'KlingAI': '/logos/klingai.svg',
    'Krea': '/logos/krea.svg',
    'Kwai': '/logos/kwai.svg',
    'Leonardo AI': '/logos/leonardo-ai.svg',
    'Lightricks': '/logos/lightricks.svg',
    'LLaVA': '/logos/llava.svg',
    'Luma AI': '/logos/luma-ai.svg',
    'Meituan': '/logos/meituan.svg',
    'Meta': '/logos/meta.svg',
    'Microsoft': '/logos/microsoft.svg',
    'Microsoft AI': '/logos/microsoft-ai.svg',
    'MiniMax': '/logos/minimax.svg',
    'Mistral': '/logos/mistral.svg',
    'Moonshot': '/logos/moonshot.svg',
    'Nvidia': '/logos/nvidia.svg',
    'OpenAI': '/logos/openai.svg',
    'OpenBMB': '/logos/openbmb.svg',
    'OpenGVLab': '/logos/opengvlab.svg',
    'Perplexity AI': '/logos/perplexity-ai.svg',
    'Pika': '/logos/pika.svg',
    'Pixverse': '/logos/pixverse.svg',
    'Poolside': '/logos/poolside.svg',
    'Pruna': '/logos/pruna.svg',
    'Recraft': '/logos/recraft.svg',
    'Reve': '/logos/reve.svg',
    'Runway': '/logos/runway.svg',
    'SpaceXAI': '/logos/spacexai.svg',
    'Stability': '/logos/stability.svg',
    'Stepfun': '/logos/stepfun.svg',
    'Tencent': '/logos/tencent.svg',
    'Vidu': '/logos/vidu.svg',
    'Xiaomi': '/logos/xiaomi.svg',
    'Z.ai': '/logos/z-ai.svg',
    // Aliases: the parser's name-based org fallback (no svg <title>, no
    // subtitle) emits these spellings instead of the site's labels.
    'Mistral AI': '/logos/mistral.svg',
    'xAI': '/logos/spacexai.svg',
};

function orgInitials(orgName: string): string {
    return orgName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0])
        .join('')
        .toUpperCase();
}

// Srcs that already 404'd this page load — rows remount on every sort
// toggle, so without this each unmapped org would re-fire its 404 (and a
// console warning) on every remount.
const failedLogoSrcs = new Set<string>();

// Curated map first, then the auto-harvested file the leaderboard route
// writes for new orgs (lib/ai/org-logos.ts), then the initials badge when
// the file doesn't exist (404 → onError).
const OrgBadge: React.FC<{ orgName: string }> = ({ orgName }) => {
    const src = ORG_LOGOS[orgName] ?? `/logos/auto/${orgSlug(orgName)}.svg`;
    const [failed, setFailed] = useState(() => failedLogoSrcs.has(src));
    useEffect(() => { setFailed(failedLogoSrcs.has(src)); }, [src]);

    if (failed) {
        return (
            <span
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded bg-white/10 text-white/70 text-[10px] font-semibold leading-none"
                title={orgName}
            >
                {orgInitials(orgName)}
            </span>
        );
    }
    return (
        <img
            src={src}
            alt={orgName}
            title={orgName}
            className="shrink-0 w-5 h-5"
            onError={() => { failedLogoSrcs.add(src); setFailed(true); }}
        />
    );
};

export interface LLMLeaderboardCategory {
    id: string;
    label: string;
}

interface LLMLeaderboardCardProps {
    models: LLMModelInfo[];
    onRefresh?: () => void;
    activeCategory?: string;
    onCategoryChange?: (category: string) => void;
    categories?: LLMLeaderboardCategory[];
}

type SortField = 'rank' | 'eloScore' | 'votes';
type SortOrder = 'asc' | 'desc';

export const LLMLeaderboardCard: React.FC<LLMLeaderboardCardProps> = ({
    models,
    onRefresh,
    activeCategory,
    onCategoryChange,
    categories
}) => {
    const [sortField, setSortField] = useState<SortField>('rank');
    const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
        } else {
            setSortField(field);
            setSortOrder(field === 'rank' ? 'asc' : 'desc');
        }
    };

    const sortedModels = useMemo(() => {
        if (!models) return [];
        return [...models].sort((a, b) => {
            const valA = a[sortField] || 0;
            const valB = b[sortField] || 0;
            if (sortOrder === 'desc') {
                return valB - valA;
            } else {
                return valA - valB;
            }
        });
    }, [models, sortField, sortOrder]);

    if (!models || models.length === 0) return null;

    const getSortIcon = (field: SortField) => {
        if (sortField !== field) return <ArrowUpDown className="w-3 h-3 text-white/20 group-hover:text-white/50 inline ml-1 transition-colors" />;
        if (sortOrder === 'asc') return <ArrowUp className="w-3 h-3 text-indigo-400 inline ml-1" />;
        return <ArrowDown className="w-3 h-3 text-indigo-400 inline ml-1" />;
    };

    return (
        <Card
            title="Chatbot Arena Leaderboard (LMSYS)"
            icon={Trophy}
            iconColorClass="text-indigo-400"
            wrapperClassName="relative"
            action={onRefresh ? <ReloadButton onReload={onRefresh} /> : undefined}
        >
            {categories && categories.length > 0 && onCategoryChange && (
                <div className="flex items-center gap-2 mb-4 overflow-x-auto custom-scrollbar pb-1 pb-scroll shrink-0 touch-pan-x">
                    {categories.map((cat) => (
                        <button
                            key={cat.id}
                            onClick={() => onCategoryChange(cat.id)}
                            className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${activeCategory === cat.id
                                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                                : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80 border border-white/5'
                                }`}
                        >
                            {cat.label}
                        </button>
                    ))}
                </div>
            )}

            <div className="flex items-center justify-between gap-4 px-3 pb-2 text-xs font-medium text-white/50 uppercase tracking-wider border-b border-white/10 mb-2 shrink-0">
                <div className="flex-1 min-w-0 flex items-center gap-1 w-20 text-[10px]">
                    <button onClick={() => handleSort('rank')} className="flex items-center group hover:text-white/80 transition-colors shrink-0 mr-4">
                        RANK {getSortIcon("rank")}
                    </button>
                    <span className="flex-1 min-w-0 pl-7 text-left">MODEL</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 pr-1">
                    <div className="hidden sm:flex items-center justify-center gap-1 w-20 text-[10px]">
                        <a href="https://lmarena.ai/" target="_blank" rel="noreferrer" className="hover:text-purple-400 transition-colors" title="Learn about Chatbot Arena Votes">
                            <Info className="w-3 h-3" />
                        </a>
                        <button onClick={() => handleSort('votes')} className="flex items-center group hover:text-white/80 transition-colors">
                            VOTES {getSortIcon("votes")}
                        </button>
                    </div>
                    <div className="flex items-center justify-center w-20 text-[10px]">
                        <button onClick={() => handleSort('eloScore')} className="flex items-center text-indigo-300/70 hover:text-indigo-300 transition-colors group">
                            ELO SCORE {getSortIcon("eloScore")}
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-2 -mr-2 space-y-2">
                {sortedModels.map((model, idx) => (
                    <div key={`${model.rank}-${model.id}-${idx}`} className="group flex items-center justify-between gap-4 bg-white/5 hover:bg-white/10 py-1.5 px-3 rounded-lg transition-colors border border-white/5">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                            <span className="text-white/40 font-mono text-sm inline-block w-6 shrink-0 text-right">
                                #{model.rank}
                            </span>

                            {/* Org badge: curated logo → auto-harvested logo → initials */}
                            {model.orgName && model.orgName !== 'Unknown' && (
                                <OrgBadge orgName={model.orgName} />
                            )}

                            <div className="flex flex-col min-w-0 ml-1">
                                <span className="text-sm font-medium text-white truncate group-hover:text-indigo-400 transition-colors" title={model.name}>
                                    {model.name}
                                </span>
                                {((model.orgName && model.orgName !== 'Unknown') || model.license) && (
                                    <span className="text-[10px] text-white/40 truncate uppercase tracking-wider font-semibold">
                                        {[model.orgName !== 'Unknown' ? model.orgName : '', model.license].filter(Boolean).join(' · ')}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 pr-1">
                            {model.votes !== undefined && (
                                <div className="hidden sm:flex items-center justify-center w-20 text-sm text-purple-400 font-mono" title="Total Votes">
                                    {model.votes.toLocaleString()}
                                </div>
                            )}
                            <div className="flex items-center justify-center w-20 text-sm text-white font-semibold font-mono" title="Arena Elo Score">
                                {model.eloScore}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </Card>
    );
};
