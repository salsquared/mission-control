"use client";

import React from "react";
import { ResponsiveContainer, LineChart, Line, YAxis, XAxis, Tooltip, CartesianGrid } from "recharts";
import { Loader2 } from "lucide-react";

export interface GraphWidgetProps {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any[];
    loading?: boolean;
    xKey: string;
    yKey: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    xFormatter?: (val: any) => string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yFormatter?: (val: any) => string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CustomTooltip?: React.FC<any>;
    color?: string;
}

export const GraphWidget: React.FC<GraphWidgetProps> = ({
    data,
    loading,
    xKey,
    yKey,
    xFormatter,
    yFormatter,
    CustomTooltip,
    color = "#f97316"
}) => {
    return (
        <div className="flex-1 w-full min-h-[220px]">
            {!loading && data?.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#555555" />
                        <XAxis
                            dataKey={xKey}
                            tickFormatter={xFormatter}
                            minTickGap={30}
                            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'monospace' }}
                            tickMargin={10}
                            axisLine={false}
                            tickLine={false}
                            padding={{}}
                        />
                        <YAxis
                            domain={['auto', 'auto']}
                            tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: 10, fontFamily: 'monospace' }}
                            tickFormatter={yFormatter}
                            axisLine={false}
                            tickLine={false}
                            width={45}
                        />
                        {CustomTooltip ? <Tooltip content={<CustomTooltip />} /> : <Tooltip />}
                        <Line
                            type="monotone"
                            dataKey={yKey}
                            stroke={color}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4, fill: color, stroke: '#000', strokeWidth: 2 }}
                            isAnimationActive={true}
                        />
                    </LineChart>
                </ResponsiveContainer>
            ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin" />
                </div>
            )}
        </div>
    );
};
