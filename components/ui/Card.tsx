"use client";
import React, { useState } from 'react';
import { LucideIcon, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CardProps {
    title?: string;
    icon?: any;
    iconColorClass?: string;
    action?: React.ReactNode;
    children: React.ReactNode;
    contentClassName?: string;
    wrapperClassName?: string;
    withInnerContainer?: boolean;
    loading?: boolean;
    collapsible?: boolean;
    defaultCollapsed?: boolean;
}

export const Card: React.FC<CardProps> = ({
    title,
    icon: Icon,
    iconColorClass = "text-cyan-400",
    action,
    children,
    contentClassName,
    wrapperClassName,
    withInnerContainer = false,
    loading = false,
    collapsible = false,
    defaultCollapsed = false,
}) => {
    const [collapsed, setCollapsed] = useState(defaultCollapsed);
    const showHeader = title || action || Icon || collapsible;
    const Chevron = collapsed ? ChevronRight : ChevronDown;
    const toggle = () => setCollapsed((c) => !c);
    return (
        <div className={cn("flex flex-col h-full w-full", wrapperClassName)}>
            {showHeader && (
                <div className={cn("flex items-center justify-between shrink-0", collapsed ? "mb-0" : "mb-4", iconColorClass)}>
                    {collapsible ? (
                        <button
                            type="button"
                            onClick={toggle}
                            className="flex items-center gap-2 -ml-1 pl-1 pr-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                            aria-expanded={!collapsed}
                            title={collapsed ? "Expand" : "Collapse"}
                        >
                            <Chevron className="w-4 h-4 opacity-70" />
                            {Icon && (React.isValidElement(Icon) ? Icon : <Icon className="w-5 h-5" />)}
                            {title && <h3 className="font-bold tracking-wider uppercase text-sm">{title}</h3>}
                        </button>
                    ) : (
                        <div className="flex items-center gap-2">
                            {Icon && (React.isValidElement(Icon) ? Icon : <Icon className="w-5 h-5" />)}
                            {title && <h3 className="font-bold tracking-wider uppercase text-sm">{title}</h3>}
                        </div>
                    )}
                    {action && <div>{action}</div>}
                </div>
            )}
            {!collapsed && (
                <div className={cn(
                    "flex-1 flex flex-col min-h-0 min-w-0", // min-h-0 and min-w-0 natively confine internal scrolling elements!
                    withInnerContainer ? "p-4 border border-dashed border-white/10 rounded-xl bg-black/20" : "",
                    contentClassName,
                    loading && "items-center justify-center"
                )}>
                    {loading ? (
                        <div className="flex flex-col items-center justify-center p-8 gap-3 opacity-50 w-full h-full">
                            <Loader2 className="w-8 h-8 animate-spin text-cyan-500" />
                            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Loading...</p>
                        </div>
                    ) : (
                        children
                    )}
                </div>
            )}
        </div>
    );
};
