import React, { useState } from "react";
import { motion, Reorder } from "framer-motion";
import { DashConfig } from "../Dashboard";
import { useThemeStore } from "@/components/providers/themeStore";
import { Edit2, Check, GripHorizontal } from "lucide-react";

interface LaunchpadOverlayProps {
    dashes: DashConfig[];
    goToSlide: (id: string) => void;
}

export const LaunchpadOverlay: React.FC<LaunchpadOverlayProps> = ({ dashes, goToSlide }) => {
    const { dashOrder, setDashOrder, dashTitles, setDashTitle } = useThemeStore();
    const [isEditing, setIsEditing] = useState(false);
    const handleReorder = (newItems: string[]) => {
        setDashOrder(newItems);
    };

    return (
        <motion.div
            key="launchpad"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="relative z-10 w-full h-full px-20 pt-12 pb-20 overflow-y-auto flex flex-col"
        >
            {/* Edit Toggles */}
            <div className="flex justify-end mb-8 w-full shrink-0 z-20">
                <button
                    onClick={() => setIsEditing(!isEditing)}
                    className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full transition-all text-white"
                >
                    {isEditing ? (
                        <>
                            <Check className="w-4 h-4" /> Done Editing
                        </>
                    ) : (
                        <>
                            <Edit2 className="w-4 h-4" /> Edit Views
                        </>
                    )}
                </button>
            </div>

            <Reorder.Group
                axis="y"
                values={dashOrder}
                onReorder={handleReorder}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 w-full"
                layoutScroll
            >
                {dashOrder.map((id) => {
                    const dash = dashes.find(d => d.id === id);
                    if (!dash) return null;

                    return (
                        <Reorder.Item
                            key={id}
                            value={id}
                            dragListener={isEditing}
                            className={`group relative flex flex-col items-center justify-center pt-10 pb-8 px-8 rounded-3xl border ${isEditing ? 'border-primary/50 bg-white/10' : 'border-white/10 bg-white/5'} hover:bg-white/10 hover:border-white/30 transition-all duration-300 hover:scale-[1.02] ${isEditing ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
                        >
                            {!isEditing && (
                                <div 
                                    className="absolute inset-0 z-10" 
                                    onClick={() => goToSlide(dash.id)} 
                                />
                            )}

                            {isEditing && (
                                <div className="absolute top-3 left-1/2 -translate-x-1/2 opacity-50 cursor-grab z-20 text-white/70 hover:text-white">
                                    <GripHorizontal className="w-6 h-6" />
                                </div>
                            )}

                            <div className="text-xl font-bold text-white mb-4 tracking-wider group-hover:text-white/80 z-20">
                                {isEditing ? (
                                    <input
                                        type="text"
                                        value={dashTitles[dash.id] || dash.title}
                                        onChange={(e) => setDashTitle(dash.id, e.target.value)}
                                        className="bg-black/50 border border-white/20 rounded-md px-3 py-1 text-center outline-none focus:border-white w-full"
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                ) : (
                                    dashTitles[dash.id] || dash.title
                                )}
                            </div>
                            <div className="w-full h-48 rounded-xl bg-black/50 border border-white/5 group-hover:border-white/20 overflow-hidden relative flex items-center justify-center pointer-events-none">
                                <div className="absolute inset-0 w-[400%] h-[400%] origin-top-left scale-[0.25]">
                                    <div className="w-full h-full p-8 relative">
                                        <div className="absolute inset-0 z-50 bg-transparent pointer-events-auto" /> 
                                        {/* Block pointer events on inner views so charts/inputs don't capture drags */}
                                        {dash.component}
                                    </div>
                                </div>
                            </div>
                        </Reorder.Item>
                    );
                })}
            </Reorder.Group>
        </motion.div>
    );
};
