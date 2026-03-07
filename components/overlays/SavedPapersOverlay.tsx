import React, { useEffect, useState } from "react";
import { X, Bookmark, Heart, Check, Trash2, ExternalLink, PlusCircle, Loader2, Search } from "lucide-react";

interface SavedPaper {
    id: string;
    paperId: string;
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
    topic: string; // The topic passed from Dashboard Context
    onClose: () => void;
}

export const SavedPapersOverlay: React.FC<SavedPapersOverlayProps> = ({ topic, onClose }) => {
    const [papers, setPapers] = useState<SavedPaper[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'READ_LATER' | 'FAVORITE' | 'READ' | 'IMPORT'>('READ_LATER');
    const [viewTopic, setViewTopic] = useState<string>(
        topic === 'General' ? 'All' : topic
    );

    // Import State
    const [importInput, setImportInput] = useState("");
    const [isSearching, setIsSearching] = useState(false);
    const [importError, setImportError] = useState("");
    const [preview, setPreview] = useState<any | null>(null);
    const [selectedTopic, setSelectedTopic] = useState<'AI' | 'Space' | 'Crypto' | 'Physics' | 'Finance'>(
        topic === 'General' ? 'AI' : (topic as any)
    );

    const fetchPapers = async () => {
        if (activeTab === 'IMPORT') return; // Don't fetch when on import tab
        setLoading(true);
        try {
            const url = viewTopic === 'All' ? '/api/research/saved' : `/api/research/saved?topic=${viewTopic}`;
            const res = await fetch(url);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewTopic, activeTab]);

    useEffect(() => {
        if (viewTopic !== 'All') {
            setSelectedTopic(viewTopic as any);
        }
    }, [viewTopic]);

    const handleDelete = async (paperId: string) => {
        setPapers(prev => prev.filter(p => p.paperId !== paperId));
        try {
            await fetch(`/api/research/saved?paperId=${paperId}`, { method: 'DELETE' });
        } catch (err) {
            console.error(err);
            fetchPapers(); // revert
        }
    };

    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!importInput.trim()) return;

        setIsSearching(true);
        setImportError("");
        setPreview(null);

        try {
            const res = await fetch('/api/research/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: importInput.trim() })
            });

            const data = await res.json();
            if (res.ok && data.paperId) {
                setPreview(data);
            } else {
                setImportError(data.error || "Failed to fetch paper details.");
            }
        } catch (err: any) {
            console.error("Import error:", err);
            setImportError("An unexpected error occurred while fetching.");
        } finally {
            setIsSearching(false);
        }
    };

    const handleSaveImport = async (status: 'READ' | 'READ_LATER' | 'FAVORITE') => {
        if (!preview || !preview.paperId) {
            setImportError("Could not generate a unique identifier to save this paper.");
            return;
        }

        try {
            const res = await fetch('/api/research/saved', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    paperId: preview.paperId,
                    title: preview.title,
                    summary: preview.summary,
                    url: preview.url,
                    authors: preview.author,
                    publishedAt: preview.published_at,
                    topic: selectedTopic,
                    status
                })
            });

            if (res.ok) {
                setImportInput("");
                setPreview(null);
                // Switch to that tab implicitly to see what we just imported
                setActiveTab(status);
                // Don't auto-close! They might want to see the list again.
            } else {
                const errData = await res.json();
                setImportError(errData.error || "Failed to save paper.");
            }
        } catch (err) {
            console.error("Save error:", err);
            setImportError("Failed to save paper to list.");
        }
    };

    const filteredPapers = papers.filter(p => p.status === activeTab);

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-md h-full bg-[#111] border-l border-white/10 flex flex-col shadow-2xl animate-in slide-in-from-right-full duration-300">
                <div className="flex flex-col border-b border-white/10 shrink-0">
                    <div className="flex items-center justify-between p-4 pb-2">
                        <h2 className="text-lg font-semibold text-white">Library</h2>
                        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-md text-white/60 hover:text-white transition-colors">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="flex px-4 pb-4 gap-2 overflow-x-auto no-scrollbar">
                        {['All', 'AI', 'Space', 'Crypto', 'Physics', 'Finance'].map(t => (
                            <button
                                key={t}
                                onClick={() => setViewTopic(t)}
                                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap border ${viewTopic === t ? 'bg-white text-black border-white' : 'bg-transparent text-white/60 border-white/20 hover:border-white/40 hover:text-white'}`}
                            >
                                {t === 'All' ? 'All Topics' : t}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex p-4 gap-2 border-b border-white/5 shrink-0 overflow-x-auto no-scrollbar">
                    <button
                        onClick={() => setActiveTab('IMPORT')}
                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 whitespace-nowrap min-w-max ${activeTab === 'IMPORT' ? 'bg-purple-500/20 text-purple-400' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>
                        <PlusCircle className="w-4 h-4" /> Add
                    </button>
                    <button
                        onClick={() => setActiveTab('READ_LATER')}
                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 whitespace-nowrap min-w-max ${activeTab === 'READ_LATER' ? 'bg-blue-500/20 text-blue-400' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>
                        <Bookmark className="w-4 h-4" /> Waitlist
                    </button>
                    <button
                        onClick={() => setActiveTab('FAVORITE')}
                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 whitespace-nowrap min-w-max ${activeTab === 'FAVORITE' ? 'bg-rose-500/20 text-rose-400' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>
                        <Heart className="w-4 h-4" /> Favs
                    </button>
                    <button
                        onClick={() => setActiveTab('READ')}
                        className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 whitespace-nowrap min-w-max ${activeTab === 'READ' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>
                        <Check className="w-4 h-4" /> Read
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {activeTab === 'IMPORT' ? (
                        <div className="flex flex-col gap-6">
                            <form onSubmit={handleSearch} className="flex flex-col gap-2">
                                <label className="text-sm font-medium text-white/70">Fetch Paper by URL or DOI</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        placeholder="ArXiv URL, Abstract Link, or DOI..."
                                        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                                        value={importInput}
                                        onChange={(e) => setImportInput(e.target.value)}
                                        disabled={isSearching}
                                    />
                                    <button
                                        type="submit"
                                        disabled={!importInput.trim() || isSearching}
                                        className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center min-w-[44px]"
                                    >
                                        {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                                    </button>
                                </div>
                                {importError && <p className="text-rose-400 text-xs mt-1">{importError}</p>}
                                <p className="text-xs text-white/30 text-center mt-2">
                                    Supports generic URLs containing papers or standard DOI links (e.g. 10.1038/s41586-025-09917-9)
                                </p>
                            </form>

                            {preview && (
                                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 bg-white/5 border border-white/10 p-5 rounded-xl flex flex-col gap-4 shadow-lg">
                                    <div className="flex flex-col gap-1">
                                        <h3 className="text-sm font-bold leading-snug">{preview.title}</h3>
                                        <div className="text-xs text-purple-400/80 mt-1 line-clamp-2">
                                            {preview.author}
                                        </div>
                                        <div className="text-[10px] text-white/30 truncate mt-0.5">
                                            Published {new Date(preview.published_at).toLocaleDateString()} | Source: {preview.source}
                                        </div>
                                    </div>

                                    <div className="text-xs text-white/60 leading-relaxed bg-black/20 p-3 rounded-lg border border-white/5 max-h-[150px] overflow-y-auto no-scrollbar">
                                        {preview.summary}
                                    </div>

                                    <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
                                        <label className="text-xs font-semibold text-white/50 uppercase tracking-widest pl-1">Assign Topic View</label>
                                        <div className="flex flex-wrap gap-2">
                                            {['AI', 'Space', 'Crypto', 'Physics', 'Finance'].map(t => (
                                                <button
                                                    key={t}
                                                    onClick={() => setSelectedTopic(t as any)}
                                                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${selectedTopic === t ? 'bg-purple-500/20 text-purple-300 border-purple-500/30' : 'bg-transparent text-white/50 border-white/10 hover:border-white/30 hover:text-white/80'}`}
                                                >
                                                    {t}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2 mt-2">
                                        <button onClick={() => handleSaveImport('READ_LATER')} className="flex items-center justify-center gap-2 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-xs font-medium rounded-lg transition-colors border border-blue-500/20">
                                            <Bookmark className="w-3.5 h-3.5" /> Waitlist
                                        </button>
                                        <button onClick={() => handleSaveImport('READ')} className="flex items-center justify-center gap-2 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-medium rounded-lg transition-colors border border-emerald-500/20">
                                            <Check className="w-3.5 h-3.5" /> Mark Read
                                        </button>
                                        <button onClick={() => handleSaveImport('FAVORITE')} className="col-span-2 flex items-center justify-center gap-2 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-medium rounded-lg transition-colors border border-rose-500/20">
                                            <Heart className="w-3.5 h-3.5" /> Add to Favorites
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : loading ? (
                        <div className="text-center text-white/40 py-8 text-sm flex flex-col items-center gap-2">
                            <Loader2 className="w-6 h-6 animate-spin opacity-50" />
                            Loading Library...
                        </div>
                    ) : filteredPapers.length === 0 ? (
                        <div className="text-center text-white/40 py-8 text-sm flex flex-col items-center gap-3">
                            {activeTab === 'READ_LATER' && <Bookmark className="w-8 h-8 opacity-20" />}
                            {activeTab === 'FAVORITE' && <Heart className="w-8 h-8 opacity-20" />}
                            {activeTab === 'READ' && <Check className="w-8 h-8 opacity-20" />}
                            <p>No papers found in this category for {viewTopic === 'All' ? 'any topic' : viewTopic}.</p>
                            <button onClick={() => setActiveTab('IMPORT')} className="mt-4 text-purple-400 hover:text-purple-300 text-xs underline underline-offset-4">
                                Add a paper
                            </button>
                        </div>
                    ) : (
                        filteredPapers.map(paper => (
                            <div key={paper.id} className="bg-white/5 border border-white/10 rounded-lg p-4 group flex flex-col gap-2">
                                <div>
                                    <h3 className="text-sm font-medium text-white mb-1.5 leading-tight">
                                        {paper.title}
                                    </h3>
                                    <div className="text-xs text-white/40 mb-2 truncate">
                                        {paper.authors} • {new Date(paper.publishedAt).toLocaleDateString()}
                                    </div>
                                </div>
                                <div className="flex items-center justify-between mt-auto">
                                    <a
                                        href={paper.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs font-medium text-purple-400 hover:text-purple-300 flex items-center gap-1 transition-colors"
                                    >
                                        Read Paper <ExternalLink className="w-3 h-3" />
                                    </a>
                                    <button
                                        onClick={() => handleDelete(paper.paperId)}
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
