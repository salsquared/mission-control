import React from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export interface KanbanColumnDef {
    id: string;
    title: string;
    statuses: string[];
    colorClass: string;
}

interface KanbanWidgetProps<T> {
    items: T[];
    columns: KanbanColumnDef[];
    getStatus: (item: T) => string;
    renderItem: (item: T, index: number) => React.ReactNode;
    emptyText?: string;
    loading?: boolean;
}

export function KanbanWidget<T>({ items, columns, getStatus, renderItem, emptyText = "No items", loading = false }: KanbanWidgetProps<T>) {
    
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
                const columnItems = items.filter(item => col.statuses.includes(getStatus(item)));
                
                return (
                    <div key={col.id} className="flex flex-col gap-3 min-w-[250px] w-[250px] shrink-0 bg-black/20 border border-white/5 rounded-xl p-4 h-full overflow-y-auto custom-scrollbar">
                        <div className="flex justify-between items-center mb-4 sticky top-0 bg-transparent z-10 pb-2">
                            <h4 className="font-semibold text-slate-200">{col.title}</h4>
                            <span className={cn("text-xs px-2.5 py-0.5 rounded-full font-medium", col.colorClass)}>
                                {columnItems.length}
                            </span>
                        </div>
                        {columnItems.length === 0 ? (
                            <div className="text-center text-sm text-slate-600 my-auto py-8">{emptyText}</div>
                        ) : (
                            columnItems.map((item, idx) => (
                                <React.Fragment key={idx}>
                                    {renderItem(item, idx)}
                                </React.Fragment>
                            ))
                        )}
                    </div>
                );
            })}
        </div>
    );
}
