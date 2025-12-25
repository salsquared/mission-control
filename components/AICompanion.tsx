"use client";

import React, { useState, useEffect } from "react";
import { Send, Bot, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";

interface AICompanionProps {
    activeContext: string | null;
}

interface Message {
    id: string;
    role: "user" | "assistant";
    text: string;
}

export const AICompanion: React.FC<AICompanionProps> = ({ activeContext }) => {
    const [messages, setMessages] = useState<Message[]>([
        { id: "1", role: "assistant", text: "Systems online. Monitoring all frequencies." }
    ]);
    const [input, setInput] = useState("");
    const [isTyping, setIsTyping] = useState(false);


    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;

        const userMsg: Message = { id: Date.now().toString(), role: "user", text: input };
        setMessages(prev => [...prev, userMsg]);
        setInput("");
        setIsTyping(true);

        // Mock response
        setTimeout(() => {
            const responseText = activeContext === "rocketry" ? "Calculating trajectory..." :
                activeContext === "crypto" ? "Gas fees are low right now." :
                    "I can help with that.";
            setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: "assistant", text: responseText }]);
            setIsTyping(false);
        }, 1200);
    };

    return (
        <div className="flex flex-col h-full bg-black/40 backdrop-blur-md rounded-xl border border-white/10 overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 p-3 border-b border-white/10 bg-white/5">
                <div className="relative">
                    <Bot className="w-5 h-5 text-cyan-400" />
                    <span className="absolute top-0 right-0 w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                </div>
                <span className="text-sm font-semibold tracking-wider text-white/80">CORE AI</span>
                {activeContext && (
                    <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-cta-blue/20 text-cyan-200 border border-cyan-500/30 uppercase tracking-widest">
                        {activeContext}
                    </span>
                )}
            </div>

            {/* Chat Area */}
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-3">
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={cn(
                            "flex flex-col",
                            msg.role === "user" ? "items-end" : "items-start"
                        )}
                    >
                        <div
                            className={cn(
                                "max-w-[85%] px-3 py-2 rounded-lg text-sm",
                                msg.role === "user"
                                    ? "bg-cyan-600/20 text-cyan-100 border border-cyan-500/30 rounded-br-none"
                                    : "bg-white/5 text-gray-300 border border-white/10 rounded-bl-none"
                            )}
                        >
                            {msg.text}
                        </div>
                    </div>
                ))}
                {isTyping && (
                    <div className="flex items-center gap-1 ml-1">
                        <span className="w-1 h-1 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                        <span className="w-1 h-1 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                        <span className="w-1 h-1 bg-gray-500 rounded-full animate-bounce" />
                    </div>
                )}
            </div>

            {/* Input */}
            <form onSubmit={handleSubmit} className="p-3 bg-white/5 border-t border-white/10">
                <div className="relative flex items-center">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Execute command..."
                        className="w-full bg-black/20 text-sm text-white placeholder:text-gray-500 border border-white/10 rounded-lg pl-3 pr-10 py-2 focus:outline-none focus:border-cyan-500/50 transition-colors"
                    />
                    <button
                        type="submit"
                        className="absolute right-2 p-1 text-gray-400 hover:text-cyan-400 transition-colors"
                    >
                        <Send className="w-4 h-4" />
                    </button>
                </div>
            </form>
        </div>
    );
};
