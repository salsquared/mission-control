"use client";

import React from "react";
import { WidgetGrid, WidgetItem } from "../WidgetGrid";
import { Rocket, Satellite, ThermometerSun } from "lucide-react";

const spaceWidgets: WidgetItem[] = [
    {
        id: "space-1",
        colSpan: 2,
        content: (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 text-cyan-400">
                    <Rocket className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Next Launch</h3>
                </div>
                <div className="flex-1 flex flex-col justify-center">
                    <div className="text-3xl font-mono text-white">T-Minus 04:20:00</div>
                    <div className="text-xs text-muted-foreground mt-1">Starship IFT-4 • Boca Chica</div>
                </div>
            </div>
        ),
    },
    {
        id: "space-2",
        colSpan: 1,
        content: (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 text-purple-400">
                    <Satellite className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Active Sats</h3>
                </div>
                <div className="text-2xl font-bold text-white">4,218</div>
                <div className="text-xs text-muted-foreground">Starlink Constellation</div>
            </div>
        ),
    },
    {
        id: "space-3",
        colSpan: 1,
        content: (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2 text-yellow-400">
                    <ThermometerSun className="w-5 h-5" />
                    <h3 className="font-bold tracking-wider uppercase text-sm">Solar Activity</h3>
                </div>
                <div className="text-xl font-bold text-white">Normal</div>
                <div className="text-xs text-muted-foreground">X-Ray Flux: A4.2</div>
            </div>
        ),
    },
];

export const SpaceDashboard: React.FC = () => {
    return (
        <div className="w-full h-full">
            <WidgetGrid items={spaceWidgets} />
        </div>
    );
};
