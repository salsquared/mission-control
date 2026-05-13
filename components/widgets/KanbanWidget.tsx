import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
    DndContext,
    DragEndEvent,
    DragOverlay,
    DragStartEvent,
    PointerSensor,
    useSensor,
    useSensors,
    useDraggable,
    useDroppable,
} from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export interface KanbanColumnDef<T> {
    id: string;
    title: string;
    colorClass: string;
    filterFn: (item: T) => boolean;
    defaultTargetStatus: string;
}

interface KanbanWidgetProps<T> {
    items: T[];
    columns: KanbanColumnDef<T>[];
    getStatus: (item: T) => string;
    getItemId?: (item: T) => string;
    onStatusChange?: (itemId: string, newStatus: string) => void;
    renderItem: (item: T, index: number) => React.ReactNode;
    emptyText?: string;
    loading?: boolean;
}

interface DraggableCardProps {
    id: string;
    children: React.ReactNode;
}

function DraggableCard({ id, children }: DraggableCardProps) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
    return (
        <div
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            style={{ touchAction: 'none', opacity: isDragging ? 0.3 : 1 }}
            className="cursor-grab"
        >
            {children}
        </div>
    );
}

interface DroppableColumnProps {
    id: string;
    enabled: boolean;
    children: React.ReactNode;
    className?: string;
}

function DroppableColumn({ id, enabled, children, className }: DroppableColumnProps) {
    const { setNodeRef, isOver } = useDroppable({ id, disabled: !enabled });
    return (
        <div
            ref={setNodeRef}
            className={cn(className, isOver && 'ring-2 ring-blue-500/40')}
        >
            {children}
        </div>
    );
}

export function KanbanWidget<T>({
    items,
    columns,
    getStatus,
    getItemId,
    onStatusChange,
    renderItem,
    emptyText = 'No items',
    loading = false,
}: KanbanWidgetProps<T>) {
    // 6px activation distance keeps click-through working for cards with their
    // own onClick handlers (a tap registers as a click; a real drag exceeds 6px).
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
    const isDraggable = !!(getItemId && onStatusChange);
    const [activeId, setActiveId] = useState<string | null>(null);

    if (loading && items.length === 0) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <Loader2 className="w-10 h-10 text-blue-500/50 animate-spin" />
            </div>
        );
    }

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(String(event.active.id));
    };

    const handleDragEnd = (event: DragEndEvent) => {
        setActiveId(null);
        const { active, over } = event;
        if (!over || !onStatusChange) return;
        const itemId = String(active.id);
        const colId = String(over.id);
        const targetCol = columns.find((c) => c.id === colId);
        if (!targetCol) return;
        onStatusChange(itemId, targetCol.defaultTargetStatus);
    };

    const handleDragCancel = () => setActiveId(null);

    const activeItem = activeId && getItemId
        ? items.find((i) => getItemId(i) === activeId)
        : null;

    const board = (
        <div className="flex relative h-full w-full gap-4 overflow-x-auto overflow-y-hidden custom-scrollbar pb-2">
            {columns.map((col) => {
                const columnItems = items.filter((item) => col.filterFn(item));
                return (
                    <DroppableColumn
                        key={col.id}
                        id={col.id}
                        enabled={isDraggable}
                        className="flex flex-col min-w-[280px] w-[32%] shrink-0 bg-black/20 border border-white/5 rounded-xl h-full overflow-hidden transition-shadow"
                    >
                        <div className="flex justify-between items-center px-4 py-3 bg-transparent border-b border-white/5 shrink-0">
                            <h4 className="font-semibold text-slate-200">{col.title}</h4>
                            <span className={cn('text-xs px-2.5 py-0.5 rounded-full font-medium', col.colorClass)}>
                                {columnItems.length}
                            </span>
                        </div>
                        <div className="flex flex-col gap-3 p-4 overflow-y-auto custom-scrollbar flex-1">
                            {columnItems.length === 0 ? (
                                <div className="text-center text-sm text-slate-600 my-auto py-8">{emptyText}</div>
                            ) : (
                                columnItems.map((item, idx) => {
                                    const id = getItemId ? getItemId(item) : undefined;
                                    if (isDraggable && id) {
                                        return (
                                            <DraggableCard key={id} id={id}>
                                                {renderItem(item, idx)}
                                            </DraggableCard>
                                        );
                                    }
                                    return <div key={id || idx}>{renderItem(item, idx)}</div>;
                                })
                            )}
                        </div>
                    </DroppableColumn>
                );
            })}
        </div>
    );

    if (!isDraggable) return board;

    return (
        <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
        >
            {board}
            {/* Forces grab cursor across the document while a drag is in flight —
                without this, browser default cursors creep in over non-droppable areas. */}
            {activeId && (
                <style>{`* { cursor: grabbing !important; }`}</style>
            )}
            {/* Portal DragOverlay to <body> so its `position: fixed` resolves to
                the viewport. Otherwise framer-motion's `transform` on the dash
                wrapper creates a containing block that traps the overlay
                inside the dash and it appears not to move. */}
            {typeof document !== 'undefined' &&
                createPortal(
                    <DragOverlay dropAnimation={null}>
                        {activeItem ? (
                            <div className="cursor-grabbing">{renderItem(activeItem, 0)}</div>
                        ) : null}
                    </DragOverlay>,
                    document.body,
                )}
        </DndContext>
    );
}
