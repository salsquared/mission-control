export interface ToastItem {
    id: string;
    message: string;
    type: 'info' | 'warning' | 'error';
}

type ToastListener = (toasts: ToastItem[]) => void;

class ToastStore {
    private items: ToastItem[] = [];
    private listeners = new Set<ToastListener>();

    subscribe(listener: ToastListener): () => void {
        this.listeners.add(listener);
        listener(this.items);
        return () => { this.listeners.delete(listener); };
    }

    push(toast: Omit<ToastItem, 'id'>) {
        const item: ToastItem = { ...toast, id: Math.random().toString(36).slice(2) };
        this.items = [...this.items, item];
        this.notify();
        setTimeout(() => this.dismiss(item.id), 5000);
    }

    dismiss(id: string) {
        this.items = this.items.filter(t => t.id !== id);
        this.notify();
    }

    private notify() {
        for (const l of this.listeners) l(this.items);
    }
}

export const toastStore = new ToastStore();
