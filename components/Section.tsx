import React from "react";
import { CardGrid, CardItem } from "./grids/CardGrid";

export interface SectionGroup {
    label: string;
    items: CardItem[];
}

interface SectionProps {
    title: string;
    description?: string;
    children?: React.ReactNode;
    /** Optional grouped card items with subheader labels. Rendered after children. */
    groups?: SectionGroup[];
    /** Layout mode for grouped CardGrids. Defaults to "grid". */
    groupLayout?: "grid" | "masonry";
}

export const Section: React.FC<SectionProps> = ({ title, description, children, groups, groupLayout = "grid" }) => {
    return (
        <div className="mb-8 last:mb-0">
            <div className="mb-4 px-6">
                <h2 className="text-2xl font-bold text-white tracking-tight">{title}</h2>
                {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
            </div>
            {children}
            {groups && groups.length > 0 && (
                <div className="space-y-2">
                    {groups.map((group) => (
                        group.items.length > 0 && (
                            <div key={group.label}>
                                <div className="px-6 pt-3 pb-1">
                                    <span className="text-[11px] uppercase tracking-widest font-bold text-white/40">
                                        {group.label}
                                    </span>
                                </div>
                                <CardGrid items={group.items} layout={groupLayout} />
                            </div>
                        )
                    ))}
                </div>
            )}
        </div>
    );
};
