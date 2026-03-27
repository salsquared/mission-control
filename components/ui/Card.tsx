import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CardProps {
    title: string;
    icon?: LucideIcon;
    iconColorClass?: string;
    action?: React.ReactNode;
    children: React.ReactNode;
    contentClassName?: string;
    wrapperClassName?: string;
    withInnerContainer?: boolean;
}

export const Card: React.FC<CardProps> = ({
    title,
    icon: Icon,
    iconColorClass = "text-cyan-400",
    action,
    children,
    contentClassName,
    wrapperClassName,
    withInnerContainer = false
}) => {
    return (
        <div className={cn("flex flex-col h-full w-full", wrapperClassName)}>
            <div className={cn("flex items-center justify-between mb-4 shrink-0", iconColorClass)}>
                <div className="flex items-center gap-2">
                    {Icon && <Icon className="w-5 h-5" />}
                    <h3 className="font-bold tracking-wider uppercase text-sm">{title}</h3>
                </div>
                {action && <div>{action}</div>}
            </div>
            <div className={cn(
                "flex-1 flex flex-col min-h-0 min-w-0", // min-h-0 and min-w-0 natively confine internal scrolling elements!
                withInnerContainer ? "p-4 border border-dashed border-white/10 rounded-xl bg-black/20" : "",
                contentClassName
            )}>
                {children}
            </div>
        </div>
    );
};
