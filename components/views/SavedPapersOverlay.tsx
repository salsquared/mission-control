import React, { useEffect, useState } from "react";
import { X, Bookmark, Heart, Check, Trash2, ExternalLink } from "lucide-react";

interface SavedPaper {
    id: string;
    arxivId: string;
    title: string;
    summary: string;
    url: string;
    authors: string;
    publishedAt: string;
    topic: string;
    status: 'READ' | 'READ_LATER' | 'FAVORITE';
    createdAt: string;
}

interface SavedPapersOverlayProps {
    topic: string;
    onClose: () => void;
}

export const SavedPapersOverlay: React.FC<SavedPapersOverlayProps> = ({ topic, onClose }) => {
    const [papers, setPapers] = useState<SavedPaper[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'READ_LATER' | 'FAVORITE' | 'READ'>('READ_LATER');

    const fetchPapers = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/research/saved?topic=${topic}`);
            if (res.ok) {
                const data = await res.json();
                setPapers(data);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPapers();
    }, [topic]);

    const handleDelete = async (arxivId: string) => {
        setPapers(prev => prev.filter(p => p.arxivId !== arxivId));
        try {
            await fetch(`/api/research/saved?arxivId=${arxivId}`, { method: 'DELETE' });
        } catch (err) {
            console.error(err);
            fetchPapers(); // revert
        }
    };

    const filteredPapers = papers.filter(p => p.status === activeTab);

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-md h-full bg-[#111] border-l border-white/10 flex flex-col shadow-2xl animate-in slide-in-from-right-full duration-300">
                <div className="flex items-center justify-between p-4 border-b border-white/10">
                    <h2 className="text-lg font-semibold text-white">Saved Papers ({topic})</h2>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-md text-white/60 hover:text-white transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex p-4 gap-2 border-b border-white/5">
                    <button
                        onClick={() => setActiveTab('READ_LATER')}
                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'READ_LATER' ? 'bg-blue-500/20 text-blue-400' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>
                        <Bookmark className="w-4 h-4" /> Waitlist
                    </button>
                    <button
                        onClick={() => setActiveTab('FAVORITE')}
                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'FAVORITE' ? 'bg-rose-500/20 text-rose-400' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>
                        <Heart className="w-4 h-4" /> Favorites
                    </button>
                    <button
                        onClick={() => setActiveTab('READ')}
                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'READ' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>
                        <Check className="w-4 h-4" /> Read
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {loading ? (
                        <div className="text-center text-white/40 py-8 text-sm">Loading...</div>
                    ) : filteredPapers.length === 0 ? (
                        <div className="text-center text-white/40 py-8 text-sm flex flex-col items-center gap-2">
                            <Bookmark className="w-8 h-8 opacity-20" />
                            No papers in this list.
                        </div>
                    ) : (
                        filteredPapers.map(paper => (
                            <div key={paper.id} className="bg-white/5 border border-white/10 rounded-lg p-4 group">
                                <h3 className="text-sm font-medium text-white mb-2 leading-tight">
                                    {paper.title}
                                </h3>
                                <div className="text-xs text-white/40 mb-3 truncate">
                                    {paper.authors} • {new Date(paper.publishedAt).toLocaleDateString()}
                                </div>
                                <div className="flex items-center justify-between">
                                    <a
                                        href={paper.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs font-medium text-purple-400 hover:text-purple-300 flex items-center gap-1 transition-colors"
                                    >
                                        Read Paper <ExternalLink className="w-3 h-3" />
                                    </a>
                                    <button
                                        onClick={() => handleDelete(paper.arxivId)}
                                        className="text-white/30 hover:text-rose-400 p-1.5 rounded-md hover:bg-rose-500/10 transition-colors opacity-0 group-hover:opacity-100"
                                        title="Remove from list"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};
