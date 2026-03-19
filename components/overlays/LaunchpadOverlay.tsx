import React, { useState } from "react";
import { motion } from "framer-motion";
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
    
    // Use a local state for dragging to prevent global store/localStorage trashing on every frame
    const initialOrder = Array.from(new Set([...dashOrder, ...dashes.map(d => d.id)]));
    const [localOrder, setLocalOrder] = useState(initialOrder);

    // Sync initialOrder if dashOrder updates externally (e.g. hydration)
    React.useEffect(() => {
        setLocalOrder(initialOrder);
    }, [dashOrder]); // Do not include dashes/initialOrder directly to avoid loops

    const [draggedItem, setDraggedItem] = useState<string | null>(null);

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
        setDraggedItem(id);
        e.dataTransfer.effectAllowed = "move";
        // Provide transparent standard drag image to prevent glitchy box
        // or just let browser use default. Default is fine as it captures the paused state.
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault(); // Necessary to allow dropping
        e.dataTransfer.dropEffect = "move";
    };

    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>, id: string) => {
        e.preventDefault();
        
        if (!draggedItem || draggedItem === id) return;

        const draggedIndex = localOrder.indexOf(draggedItem);
        const targetIndex = localOrder.indexOf(id);
        
        if (draggedIndex !== -1 && targetIndex !== -1) {
            const newOrder = [...localOrder];
            newOrder.splice(draggedIndex, 1);
            newOrder.splice(targetIndex, 0, draggedItem);
            setLocalOrder(newOrder);
        }
    };

    const handleDragEnd = () => {
        setDraggedItem(null);
        setDashOrder(localOrder);
    };

    const toggleEdit = () => {
        if (isEditing) {
            setDashOrder(localOrder);
        }
        setIsEditing(!isEditing);
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
                    onClick={toggleEdit}
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

            <motion.div layout className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 w-full">
                {localOrder.map((id) => {
                    const dash = dashes.find(d => d.id === id);
                    if (!dash) return null;

                    return (
                        <motion.div layout key={id} className="h-full w-full">
                            <div
                                draggable={isEditing}
                                onDragStart={(e) => handleDragStart(e, id)}
                                onDragOver={handleDragOver}
                                onDragEnter={(e) => handleDragEnter(e, id)}
                                onDragEnd={handleDragEnd}
                                className={`group relative flex flex-col items-center justify-center pt-10 pb-8 px-8 rounded-3xl border transition-all duration-300 h-full w-full 
                                    ${isEditing ? 'border-primary/50 bg-white/10 cursor-grab active:cursor-grabbing hover:scale-[1.02]' : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/30 cursor-pointer hover:scale-[1.02]'} 
                                    ${draggedItem === id ? 'opacity-40 z-50 shadow-2xl shadow-primary/20' : 'opacity-100 z-10'}`}
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
                                {isEditing ? (
                                    <div className="text-white/30 text-sm italic">
                                        [View Paused for Editing]
                                    </div>
                                ) : (
                                    <div className="absolute inset-0 w-[400%] h-[400%] origin-top-left scale-[0.25]">
                                        <div className="w-full h-full p-8 relative">
                                            <div className="absolute inset-0 z-50 bg-transparent pointer-events-auto" /> 
                                            {/* Block pointer events on inner views so charts/inputs don't capture drags */}
                                            {dash.component}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                        </motion.div>
                    );
                })}
            </motion.div>
        </motion.div>
    );
};
