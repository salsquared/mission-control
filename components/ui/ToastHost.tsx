"use client";

import { useEffect, useState } from "react";
import { toastStore, ToastItem } from "@/lib/toast-store";
import { X } from "lucide-react";

export function ToastHost() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    useEffect(() => {
        const unsub = toastStore.subscribe(setToasts);
        return () => { unsub(); };
    }, []);

    if (toasts.length === 0) return null;

    return (
        <div className="fixed bottom-4 left-4 z-[9999] flex flex-col gap-2 pointer-events-none">
            {toasts.map(toast => (
                <div
                    key={toast.id}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium shadow-lg pointer-events-auto
                        ${toast.type === 'warning' ? 'bg-amber-900/80 border-amber-500/40 text-amber-200' :
                          toast.type === 'error'   ? 'bg-red-900/80 border-red-500/40 text-red-200' :
                                                     'bg-slate-800/90 border-slate-600/40 text-slate-200'}
                        backdrop-blur-sm`}
                >
                    <span className="flex-1">{toast.message}</span>
                    <button
                        onClick={() => toastStore.dismiss(toast.id)}
                        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            ))}
        </div>
    );
}
