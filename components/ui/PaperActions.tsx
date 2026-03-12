import React from 'react';
import { Check, Bookmark, Heart, RefreshCw } from "lucide-react";

interface PaperActionsProps {
    activeStatus?: string | null;
    onAction: (e: React.MouseEvent, status: string) => void;
    onRefresh?: () => void;
}

export const PaperActions: React.FC<PaperActionsProps> = ({
    activeStatus,
    onAction,
    onRefresh
}) => {
    return (
        <div className="flex items-center gap-1 bg-black/40 rounded-full p-0.5 border border-white/5">
            {onRefresh && (
                <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRefresh(); }}
                    className="p-1.5 rounded-full transition-colors text-white/40 hover:text-white hover:bg-white/10"
                    title="Reload"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                </button>
            )}
            <button
                onClick={(e) => onAction(e, 'READ')}
                className={`p-1.5 rounded-full transition-colors ${activeStatus === 'READ' ? 'bg-emerald-500/20 text-emerald-400' : 'text-white/40 hover:text-emerald-400 hover:bg-white/10'}`}
                title="Mark as Read"
            >
                <Check className="w-3.5 h-3.5" />
            </button>
            <button
                onClick={(e) => onAction(e, 'READ_LATER')}
                className={`p-1.5 rounded-full transition-colors ${activeStatus === 'READ_LATER' ? 'bg-blue-500/20 text-blue-400' : 'text-white/40 hover:text-blue-400 hover:bg-white/10'}`}
                title="Read Later"
            >
                <Bookmark className={`w-3.5 h-3.5 ${activeStatus === 'READ_LATER' ? 'fill-blue-400' : ''}`} />
            </button>
            <button
                onClick={(e) => onAction(e, 'FAVORITE')}
                className={`p-1.5 rounded-full transition-colors ${activeStatus === 'FAVORITE' ? 'bg-rose-500/20 text-rose-400' : 'text-white/40 hover:text-rose-400 hover:bg-white/10'}`}
                title="Favorite"
            >
                <Heart className={`w-3.5 h-3.5 ${activeStatus === 'FAVORITE' ? 'fill-rose-400' : ''}`} />
            </button>
        </div>
    );
};
