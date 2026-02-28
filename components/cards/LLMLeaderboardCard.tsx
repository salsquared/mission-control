"use client";

import React, { useState, useMemo } from "react";
import { Trophy, RefreshCw, ArrowUpDown, ArrowUp, ArrowDown, Info } from "lucide-react";

export interface LLMModelInfo {
    id: string;
    rank: number;
    name: string;
    orgName?: string;
    orgLogo?: string;
    eloScore: number;
    votes: number;
}

interface LLMLeaderboardCardProps {
    models: LLMModelInfo[];
    onRefresh?: () => void;
}

type SortField = 'rank' | 'eloScore' | 'votes';
type SortOrder = 'asc' | 'desc';

export const LLMLeaderboardCard: React.FC<LLMLeaderboardCardProps> = ({ models, onRefresh }) => {
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
            let valA = a[sortField] || 0;
            let valB = b[sortField] || 0;
            if (sortOrder === 'desc') {
                return valB - valA;
            } else {
                return valA - valB;
            }
        });
    }, [models, sortField, sortOrder]);

    if (!models || models.length === 0) return null;

    const SortIcon = ({ field }: { field: SortField }) => {
        if (sortField !== field) return <ArrowUpDown className="w-3 h-3 text-white/20 group-hover:text-white/50 inline ml-1 transition-colors" />;
        if (sortOrder === 'asc') return <ArrowUp className="w-3 h-3 text-indigo-400 inline ml-1" />;
        return <ArrowDown className="w-3 h-3 text-indigo-400 inline ml-1" />;
    };

    return (
        <div className="flex flex-col flex-1 h-full w-full relative">
            <div className="flex items-center justify-between gap-4 mb-4">
                <div className="flex items-center gap-2 text-indigo-400">
                    <Trophy className="w-4 h-4 shrink-0" />
                    <span className="text-xs uppercase tracking-wider font-bold">Chatbot Arena Leaderboard (LMSYS)</span>
                </div>
                {onRefresh && (
                    <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRefresh(); }}
                        className="p-1.5 rounded-full transition-colors shrink-0 bg-black/40 text-white/40 hover:text-white hover:bg-white/10 border border-white/5"
                        title="Reload"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            <div className="flex items-center justify-between gap-4 px-3 pb-2 text-xs font-medium text-white/50 uppercase tracking-wider border-b border-white/10 mb-2">
                <div className="flex-1 min-w-0 flex items-center gap-1 w-20 text-[10px]">
                    <button onClick={() => handleSort('rank')} className="flex items-center group hover:text-white/80 transition-colors shrink-0 mr-4">
                        RANK <SortIcon field="rank" />
                    </button>
                    <span className="flex-1 min-w-0 pl-7 text-left">MODEL</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 pr-1">
                    <div className="hidden sm:flex items-center justify-center gap-1 w-20 text-[10px]">
                        <a href="https://lmarena.ai/" target="_blank" rel="noreferrer" className="hover:text-purple-400 transition-colors" title="Learn about Chatbot Arena Votes">
                            <Info className="w-3 h-3" />
                        </a>
                        <button onClick={() => handleSort('votes')} className="flex items-center group hover:text-white/80 transition-colors">
                            VOTES <SortIcon field="votes" />
                        </button>
                    </div>
                    <div className="flex items-center justify-center w-20 text-[10px]">
                        <button onClick={() => handleSort('eloScore')} className="flex items-center text-indigo-300/70 hover:text-indigo-300 transition-colors group">
                            ELO SCORE <SortIcon field="eloScore" />
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto pr-2 -mr-2 space-y-2 max-h-[400px]">
                {sortedModels.map((model, idx) => (
                    <div key={model.id} className="group flex items-center justify-between gap-4 bg-white/5 hover:bg-white/10 py-1.5 px-3 rounded-lg transition-colors border border-white/5">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                            <span className="text-white/40 font-mono text-sm inline-block w-6 shrink-0 text-right">
                                #{model.rank}
                            </span>

                            {/* Render SVG Logo dynamically if it exists */}
                            {model.orgLogo && (
                                <div
                                    className="shrink-0 w-5 h-5 flex items-center justify-center text-white/70"
                                    dangerouslySetInnerHTML={{ __html: model.orgLogo }}
                                    title={model.orgName}
                                />
                            )}

                            <div className="flex flex-col min-w-0 ml-1">
                                <span className="text-sm font-medium text-white truncate group-hover:text-indigo-400 transition-colors" title={model.name}>
                                    {model.name}
                                </span>
                                {model.orgName && model.orgName !== 'Unknown' && (
                                    <span className="text-[10px] text-white/40 truncate uppercase tracking-wider font-semibold">
                                        {model.orgName}
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
        </div>
    );
};
