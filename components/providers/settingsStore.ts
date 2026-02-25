import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
    autoResearch: boolean;
    backgroundTasks: boolean;
    setAutoResearch: (enabled: boolean) => void;
    setBackgroundTasks: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            autoResearch: false,
            backgroundTasks: false,
            setAutoResearch: (autoResearch) => set({ autoResearch }),
            setBackgroundTasks: (backgroundTasks) => set({ backgroundTasks }),
        }),
        {
            name: 'settings-storage',
        }
    )
);
