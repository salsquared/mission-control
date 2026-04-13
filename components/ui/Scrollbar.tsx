import React from "react";

export interface ScrollbarProps extends React.HTMLAttributes<HTMLDivElement> {
    children: React.ReactNode;
}

export const Scrollbar: React.FC<ScrollbarProps> = ({ children, className = "", ...props }) => {
    return (
        <div className={`overflow-y-auto custom-scrollbar ${className}`} {...props}>
            {children}
        </div>
    );
};
