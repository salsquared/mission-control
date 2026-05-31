import React, { useState } from "react";
import { motion, type PanInfo } from "framer-motion";
import { DashConfig } from "../dashboard/dashes";
import { useThemeStore } from "@/components/providers/themeStore";
import { useAppStore, type MobileLayoutPreference } from "@/components/providers/state";
import { Edit2, Check, GripHorizontal, Library, MessageSquare, X } from "lucide-react";

export type LaunchpadVariant = "fullscreen" | "sheet";

interface LaunchpadOverlayProps {
    dashes: DashConfig[];
    goToSlide: (id: string) => void;
    /** Render layout. 'fullscreen' (default) is the desktop variant that
     *  takes over the dashboard canvas. 'sheet' is the mobile variant
     *  that rises from the bottom as a 90 vh bottom-sheet over the
     *  active dash. */
    variant?: LaunchpadVariant;
    /** Required for the sheet variant — called when the user dismisses
     *  the sheet (backdrop tap or drag-down past threshold). */
    onClose?: () => void;
    /** Sheet variant only — renders a "Library" row below the dash grid
     *  if provided. Wired from MobileShell since the desktop bottom
     *  controls bar doesn't exist on mobile. */
    onOpenLibrary?: () => void;
    /** Sheet variant only — renders an "AI Companion" row below the
     *  dash grid if provided. Gated by the caller on
     *  `aiCompanionEnabled`; if the feature flag is off, pass undefined. */
    onOpenAICompanion?: () => void;
}

// Drag-down dismiss threshold for the sheet variant.
const SHEET_DISMISS_OFFSET_PX = 120;
const SHEET_DISMISS_VELOCITY_PX_S = 400;

// MD-6 — Layout segmented control options. Tuple order is the row order.
const LAYOUT_OPTIONS: { value: MobileLayoutPreference; label: string }[] = [
    { value: "auto", label: "Auto" },
    { value: "force-on", label: "Mobile" },
    { value: "force-off", label: "Desktop" },
];

export const LaunchpadOverlay: React.FC<LaunchpadOverlayProps> = ({
    dashes,
    goToSlide,
    variant = "fullscreen",
    onClose,
    onOpenLibrary,
    onOpenAICompanion,
}) => {
    const { dashOrder, setDashOrder, dashTitles, setDashTitle } = useThemeStore();
    const mobileLayoutPreference = useAppStore((s) => s.mobileLayoutPreference);
    const setMobileLayoutPreference = useAppStore((s) => s.setMobileLayoutPreference);
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
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
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

    const handleSheetDragEnd = (_e: unknown, info: PanInfo) => {
        if (
            onClose &&
            (info.offset.y > SHEET_DISMISS_OFFSET_PX || info.velocity.y > SHEET_DISMISS_VELOCITY_PX_S)
        ) {
            onClose();
        }
    };

    // ===== Body content shared between variants =====
    // Header row (Edit toggle + sheet-only close button)
    const headerRow = (
        <div className="flex items-center justify-between w-full shrink-0 z-20">
            {variant === "sheet" && onClose ? (
                <button
                    onClick={onClose}
                    className="flex items-center justify-center w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-white/80 hover:text-white"
                    aria-label="Close Launchpad"
                >
                    <X className="w-4 h-4" />
                </button>
            ) : (
                <div />
            )}
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
    );

    const dashGrid = (
        <motion.div
            layout
            className={
                variant === "sheet"
                    ? "grid grid-cols-2 gap-3 w-full"
                    : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 w-full"
            }
        >
            {localOrder.map((id) => {
                const dash = dashes.find(d => d.id === id);
                if (!dash) return null;

                const isSheet = variant === "sheet";
                return (
                    <motion.div layout key={id} className="h-full w-full">
                        <div
                            draggable={isEditing}
                            onDragStart={(e) => handleDragStart(e, id)}
                            onDragOver={handleDragOver}
                            onDragEnter={(e) => handleDragEnter(e, id)}
                            onDragEnd={handleDragEnd}
                            className={`group relative flex flex-col items-center justify-center ${isSheet ? 'pt-6 pb-5 px-4 rounded-2xl' : 'pt-10 pb-8 px-8 rounded-3xl'} border transition-all duration-300 h-full w-full
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

                            <div className={`font-bold text-white tracking-wider group-hover:text-white/80 z-20 ${isSheet ? 'text-sm mb-2' : 'text-xl mb-4'}`}>
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
                            {/* Preview block — desktop renders a scaled-down live view;
                                sheet variant skips it to keep the sheet compact and
                                avoid mounting 8 view components inside the picker. */}
                            {!isSheet && (
                                <div className="w-full h-48 rounded-xl bg-black/50 border border-white/5 group-hover:border-white/20 overflow-hidden relative flex items-center justify-center pointer-events-none">
                                    {isEditing ? (
                                        <div className="text-white/30 text-sm italic">
                                            [View Paused for Editing]
                                        </div>
                                    ) : (
                                        <div className="absolute inset-0 w-[400%] h-[400%] origin-top-left scale-[0.25]">
                                            <div className="w-full h-full p-8 relative">
                                                <div className="absolute inset-0 z-50 bg-transparent pointer-events-auto" />
                                                {dash.component}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </motion.div>
                );
            })}
        </motion.div>
    );

    // Sheet-only "More" rows for Library + AI Companion. These replace the
    // desktop bottom controls bar (which has no home on mobile).
    const moreRows = variant === "sheet" && (onOpenLibrary || onOpenAICompanion) ? (
        <div className="w-full mt-5 space-y-2">
            <div className="text-[11px] uppercase tracking-widest font-bold text-white/40 px-1">More</div>
            {onOpenLibrary && (
                <button
                    onClick={onOpenLibrary}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-white/90 transition-all"
                >
                    <Library className="w-5 h-5" />
                    <span className="text-sm font-medium">Library</span>
                </button>
            )}
            {onOpenAICompanion && (
                <button
                    onClick={onOpenAICompanion}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-white/90 transition-all"
                >
                    <MessageSquare className="w-5 h-5" />
                    <span className="text-sm font-medium">AI Companion</span>
                </button>
            )}
        </div>
    ) : null;

    // Sheet-only "Layout" segmented control (MD-6). Lets the user pin the
    // shell to mobile or desktop, or leave it as auto-by-viewport. Pinning
    // takes effect immediately — the Dashboard router re-evaluates on the
    // next render. The 'force-off' option is how a phone user opts back into
    // the desktop shell mid-session.
    const layoutControl = variant === "sheet" ? (
        <div className="w-full mt-5">
            <div className="text-[11px] uppercase tracking-widest font-bold text-white/40 px-1 mb-2">Layout</div>
            <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-white/5 border border-white/10">
                {LAYOUT_OPTIONS.map(({ value, label }) => {
                    const active = mobileLayoutPreference === value;
                    return (
                        <button
                            key={value}
                            onClick={() => setMobileLayoutPreference(value)}
                            className={`px-3 py-2 rounded-lg text-xs font-medium transition-all ${active
                                ? "bg-white/15 text-white border border-white/20"
                                : "text-white/60 hover:text-white/90 hover:bg-white/5 border border-transparent"
                                }`}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>
        </div>
    ) : null;

    if (variant === "sheet") {
        return (
            <>
                {/* Backdrop */}
                <motion.div
                    key="launchpad-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={onClose}
                    className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm"
                />
                {/* Sheet — drag-down on the handle area dismisses */}
                <motion.div
                    key="launchpad-sheet"
                    initial={{ y: "100%" }}
                    animate={{ y: 0 }}
                    exit={{ y: "100%" }}
                    transition={{ type: "spring", stiffness: 380, damping: 38 }}
                    drag="y"
                    dragConstraints={{ top: 0, bottom: 0 }}
                    dragElastic={{ top: 0, bottom: 0.2 }}
                    onDragEnd={handleSheetDragEnd}
                    className="absolute bottom-0 left-0 right-0 z-50 max-h-[90vh] rounded-t-3xl border-t border-x border-white/10 bg-neutral-950/95 backdrop-blur-xl shadow-2xl flex flex-col"
                    style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
                >
                    {/* Drag handle */}
                    <div className="flex justify-center pt-3 pb-2 shrink-0">
                        <div className="w-10 h-1.5 rounded-full bg-white/20" />
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-6 pt-2 space-y-4">
                        {headerRow}
                        {dashGrid}
                        {moreRows}
                        {layoutControl}
                    </div>
                </motion.div>
            </>
        );
    }

    // Fullscreen (desktop) variant — original layout, unchanged.
    return (
        <motion.div
            key="launchpad"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="relative z-10 w-full h-full px-20 pt-12 pb-20 overflow-y-auto custom-scrollbar flex flex-col"
        >
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

            {dashGrid}
        </motion.div>
    );
};
