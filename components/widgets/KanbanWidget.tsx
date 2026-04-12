import React from 'react';
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

export function KanbanWidget<T>({ items, columns, getStatus, getItemId, onStatusChange, renderItem, emptyText = "No items", loading = false }: KanbanWidgetProps<T>) {
    
    if (loading && items.length === 0) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <Loader2 className="w-10 h-10 text-blue-500/50 animate-spin" />
            </div>
        );
    }
    
    return (
        <div className="flex relative h-full w-full gap-4 overflow-x-auto overflow-y-hidden custom-scrollbar pb-2">
            {columns.map(col => {
                const columnItems = items.filter(item => col.filterFn(item));
                
                return (
                    <div 
                        key={col.id} 
                        className="flex flex-col min-w-[280px] w-[32%] shrink-0 bg-black/20 border border-white/5 rounded-xl h-full overflow-hidden"
                        onDragOver={(e) => {
                            if (onStatusChange) {
                                e.preventDefault(); // allow drop
                            }
                        }}
                        onDrop={(e) => {
                            if (onStatusChange) {
                                e.preventDefault();
                                const id = e.dataTransfer.getData('text/plain');
                                if (id) {
                                    onStatusChange(id, col.defaultTargetStatus);
                                }
                            }
                        }}
                    >
                        <div className="flex justify-between items-center px-4 py-3 bg-transparent border-b border-white/5 shrink-0">
                            <h4 className="font-semibold text-slate-200">{col.title}</h4>
                            <span className={cn("text-xs px-2.5 py-0.5 rounded-full font-medium", col.colorClass)}>
                                {columnItems.length}
                            </span>
                        </div>
                        <div className="flex flex-col gap-3 p-4 overflow-y-auto custom-scrollbar flex-1">
                            {columnItems.length === 0 ? (
                                <div className="text-center text-sm text-slate-600 my-auto py-8">{emptyText}</div>
                            ) : (
                            columnItems.map((item, idx) => {
                                const id = getItemId ? getItemId(item) : undefined;
                                const isDraggable = !!(getItemId && onStatusChange);
                                return (
                                    <div 
                                        key={id || idx}
                                        draggable={isDraggable}
                                        onDragStart={(e) => {
                                            if (isDraggable && id) {
                                                e.dataTransfer.setData('text/plain', id);
                                                e.dataTransfer.effectAllowed = 'move';
                                            }
                                        }}
                                        className={cn(isDraggable && "cursor-grab active:cursor-grabbing")}
                                    >
                                        {renderItem(item, idx)}
                                    </div>
                                );
                            })
                        )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
