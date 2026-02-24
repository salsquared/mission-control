import React from "react";

interface SectionProps {
    title: string;
    description?: string;
    children: React.ReactNode;
}

export const Section: React.FC<SectionProps> = ({ title, description, children }) => {
    return (
        <div className="mb-8 last:mb-0">
            <div className="mb-4 px-6">
                <h2 className="text-2xl font-bold text-white tracking-tight">{title}</h2>
                {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
            </div>
            {children}
        </div>
    );
};
