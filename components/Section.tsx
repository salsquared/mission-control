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
    // Horizontal inset lives on this outer container (not the header / children
    // individually) so the whole section — header + cards — gets a consistent
    // gutter. It sits INSIDE each view's scroll container, so the scrollbar
    // stays flush to the frame's right edge while content is inset.
    //
    // The gutter width is read from the `--section-gutter` CSS var (default 2rem,
    // == the old px-8). The active shell owns it: MobileShell shrinks it to
    // 0.5rem (px-2); DesktopShell leaves the default. Driving it off whichever
    // shell mounted — not a parallel CSS breakpoint — keeps the gutter and the
    // desktop/mobile swap (the single `isMobile` matchMedia in useMobileLayout)
    // in lockstep, so they can never transition at different widths.
    return (
        <div className="last:mb-0 px-[var(--section-gutter,2rem)]">
            <div className="mb-4">
                <h2 className="text-2xl font-bold text-white tracking-tight">{title}</h2>
                {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
            </div>
            {children}
            {groups && groups.length > 0 && (
                <div className="space-y-2">
                    {groups.map((group) => (
                        group.items.length > 0 && (
                            <div key={group.label}>
                                <div className="pt-3 pb-1">
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
