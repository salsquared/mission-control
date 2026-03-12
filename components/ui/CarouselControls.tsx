import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface CarouselControlsProps {
    currentIndex: number;
    totalItems: number;
    onNext: (e: React.MouseEvent) => void;
    onPrev: (e: React.MouseEvent) => void;
}

export const CarouselControls: React.FC<CarouselControlsProps> = ({
    currentIndex,
    totalItems,
    onNext,
    onPrev
}) => {
    if (totalItems <= 1) return null;

    return (
        <div className="flex items-center gap-2 z-20 shrink-0">
            <div className="flex gap-1 hidden sm:flex">
                {Array.from({ length: totalItems }).map((_, i) => (
                    <div
                        key={i}
                        className={`h-1.5 rounded-full transition-all duration-300 ${i === currentIndex ? 'w-3 bg-purple-400' : 'w-1.5 bg-white/20'}`}
                    />
                ))}
            </div>
            <div className="flex gap-0.5 bg-black/50 rounded-md backdrop-blur-sm">
                <button
                    onClick={onPrev}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="p-0.5 rounded-md hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer" title="Previous Paper">
                    <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                    onClick={onNext}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="p-0.5 rounded-md hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer" title="Next Paper">
                    <ChevronRight className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
};
