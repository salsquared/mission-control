import React from 'react';
import { RefreshCw } from 'lucide-react';

interface ReloadButtonProps {
    onReload: () => void;
    title?: string;
    className?: string;
}

export const ReloadButton: React.FC<ReloadButtonProps> = ({ 
    onReload, 
    title = "Reload",
    className = ""
}) => {
    return (
        <button
            onClick={(e) => { 
                e.preventDefault(); 
                e.stopPropagation(); 
                onReload(); 
            }}
            className={`p-1.5 rounded-full transition-colors shrink-0 bg-black/40 text-white/40 hover:text-white hover:bg-white/10 border border-white/5 ${className}`}
            title={title}
        >
            <RefreshCw className="w-3.5 h-3.5" />
        </button>
    );
};
