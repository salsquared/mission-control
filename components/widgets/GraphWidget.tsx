"use client";

import React, { useId } from "react";
import { ResponsiveContainer, LineChart, Line, AreaChart, ComposedChart, Area, YAxis, XAxis, Tooltip, CartesianGrid } from "recharts";
import { Loader2 } from "lucide-react";

/**
 * `"full"` — a charted readout that OWNS its card: grid, both axes, and a
 * flex-1 body that takes its bound from the call site's CardItem `height` token
 * (see FinanceView). `"sparkline"` — a bare trend line that TRAILS a headline
 * number: no axes, no grid, a definite small height that must not flex.
 */
export type GraphVariant = "full" | "sparkline";

/** A component band of a stacked sparkline. */
export interface StackKey {
    key: string;
    color: string;
    /** Tooltip name. Defaults to `key`. */
    label?: string;
}

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
    variant?: GraphVariant;
    /**
     * `"sparkline"` only. A DEFINITE Tailwind height (not a min/max):
     * ResponsiveContainer measures its parent, so a floor alone collapses it.
     */
    heightClass?: string;
    /**
     * `"sparkline"` only. Component bands stacked UNDER the `yKey` line, in
     * render order (first = bottom). They must PARTITION `yKey` — i.e. sum to it
     * — because the top of the stack then coincides with the line, which is what
     * makes the composition readable against the total.
     *
     * Supplying this switches the Y axis to ZERO-BASED, and that is a real
     * trade-off, not an oversight: a stack is meaningless without a zero
     * baseline, but zero-basing also flattens day-to-day movement in a large
     * total. Composition over wiggle — omit `stackKeys` to get the zoomed
     * dataMin/dataMax domain back.
     */
    stackKeys?: StackKey[];
    /**
     * `"sparkline"` only. `"log"` switches the Y axis to log10 — reach for it
     * when the series span orders of magnitude and the small ones would
     * otherwise be invisible.
     *
     * IT ALSO UNSTACKS THE BANDS, and that is not a shortcut. A stack encodes
     * magnitude as POSITION (each band's top is a running sum), and log destroys
     * that: the distance between two stacked values becomes their RATIO, so a
     * small band riding high on the stack — 69 sitting on 12,080 — compresses to
     * nothing, which is the opposite of what log was reached for. Stacking also
     * needs a zero baseline, and log10(0) is undefined. So in log mode each band
     * is drawn as its own line from the axis floor, where they ARE all legible;
     * the trade is that they no longer visibly sum to the total.
     */
    scale?: "linear" | "log";
    /**
     * `"sparkline"` only. Draws labelled X and Y axes. Off by default — a
     * sparkline trailing a stat has no room for them — but a small chart being
     * read for values rather than shape needs them.
     */
    axes?: boolean;
}

// Nudge the Y bounds outward by 0.2% (at least 1 unit) for the sparkline. Two
// jobs: it keeps the stroke off the clipping edge at the series' extremes, and —
// load-bearing — it turns a FLAT series into a real range. A single day, or a
// count that hasn't moved, gives dataMin === dataMax, a zero-height domain
// recharts cannot place a line inside, so the chart would come out blank exactly
// when it should read "steady at this figure".
const padBelow = (bound: number) => bound - Math.max(1, Math.abs(bound) * 0.002);
const padAbove = (bound: number) => bound + Math.max(1, Math.abs(bound) * 0.002);

// A log axis cannot contain zero, so the floor is clamped positive and the
// headroom is a RATIO rather than a difference — on a log scale a fixed offset
// is a different visual gap at each end of the range.
const LOG_FLOOR = 1;
const logBelow = (bound: number) => Math.max(LOG_FLOOR, bound / 1.15);
const logAbove = (bound: number) => bound * 1.15;

/** Plotted value for a log axis: non-positive points are floored rather than
 *  dropped, so one zero day can't cut a band's line in half. Read only by the
 *  Line's dataKey — the tooltip still reads the untouched datum, so a floored
 *  point is never REPORTED as 1. */
const logSafe = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : LOG_FLOOR;
};

/** Axis tick styling, matched to the full variant's so the two read as one system. */
const TICK_STYLE = { fill: "rgba(255,255,255,0.4)", fontSize: 10, fontFamily: "monospace" };

/** Axis ticks only — thousands abbreviated so a 36px gutter fits four decades.
 *  The tooltip keeps full precision; this is for orientation, not for reading
 *  exact values off the chart. */
const compactTick = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    if (Math.abs(n) >= 1000) return `${Number((n / 1000).toFixed(1))}k`;
    return String(n);
};

/**
 * The project's one graph component. Two variants because the same recharts
 * wiring serves two jobs whose contracts differ on every axis that matters —
 * sizing, axes, Y domain, and empty state. They render as separate trees rather
 * than one tree full of ternaries, so a change to the sparkline can't reach into
 * the finance charts; the shared surface is this props API.
 */
export const GraphWidget: React.FC<GraphWidgetProps> = (props) =>
    props.variant === "sparkline" ? <SparklineChart {...props} /> : <FullChart {...props} />;

const FullChart: React.FC<GraphWidgetProps> = ({
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

/**
 * The frame is ALWAYS rendered at `heightClass`, whatever the data — it never
 * collapses and never swaps itself for a spinner or a message, so the figure
 * above it doesn't shift as points accumulate. A single point draws as a flat
 * line rather than as nothing, so a series on its first day still reads as the
 * current value.
 */
const SparklineChart: React.FC<GraphWidgetProps> = ({
    data,
    xKey,
    yKey,
    yFormatter,
    CustomTooltip,
    color = "#c084fc",
    // 4rem. Tailwind's rem scale rather than a raw px style, and a power-of-2
    // step per the project's spacing convention (h-8 is the compact alternative).
    heightClass = "h-16",
    stackKeys,
    scale = "linear",
    axes = false,
}) => {
    // Unique per instance so several sparklines on one dash don't share a <defs>
    // gradient id (the second would silently adopt the first's color).
    const gradientId = `sparkline-${useId().replace(/:/g, "")}`;

    // A line needs two ends, so a lone point is duplicated to draw flat across the
    // full width instead of rendering nothing (dot={false} hides lone points).
    //
    // NOT when `axes` is on, though: the X axis is CATEGORICAL, and two copies of
    // one point are two identical categories. Recharts can't resolve a hover
    // index against duplicated categories, which silently kills the tooltip —
    // the chart looks right and simply stops responding to the mouse. With axes
    // the point doesn't need the trick anyway: it's placed against a labelled
    // scale, so showing it as a dot reads fine.
    const singlePoint = (data?.length ?? 0) === 1;
    const series = singlePoint && !axes ? [data[0], data[0]] : (data ?? []);
    const showDots = singlePoint && axes;
    const isLog = scale === "log";
    const stacked = (stackKeys?.length ?? 0) > 0;
    // Bands are areas only on a linear axis; see the `scale` prop for why log
    // has to unstack them.
    const banded = stacked && !isLog;
    const bandLines = stacked && isLog;

    const fmt = (value: unknown) => (yFormatter ? yFormatter(value) : Number(value).toLocaleString());

    const renderTooltip = ({ payload }: { payload?: readonly { payload?: Record<string, unknown> }[] }) => {
        const datum = payload?.[0]?.payload;
        if (!datum) return null;
        return (
            <div className="rounded border border-white/10 bg-black/90 px-2 py-1 text-[10px] shadow-lg">
                <div className="text-muted-foreground">{String(datum[xKey] ?? "")}</div>
                <div className="font-bold text-white">{fmt(datum[yKey])}</div>
                {/* Listed in `stackKeys` order — largest band at the top, down to
                    the smallest. That deliberately does NOT mirror the stack's
                    visual order (which puts the thin bands up top): reading a
                    value list is easier by magnitude than by position. */}
                {stacked && (
                    <div className="mt-1 flex flex-col gap-0.5 border-t border-white/10 pt-1">
                        {stackKeys!.map(band => (
                            <div key={band.key} className="flex items-center gap-1.5">
                                <span
                                    className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                                    style={{ backgroundColor: band.color }}
                                />
                                <span className="text-muted-foreground">{band.label ?? band.key}</span>
                                <span className="ml-auto pl-2 text-white">{fmt(datum[band.key])}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    // Powers of ten spanning the plotted values. Recharts' automatic log ticks
    // land on uneven values that collide once abbreviated ("1.2k", "1.3k"); one
    // label per decade is the only spacing a log axis reads cleanly at.
    const logTicks = (() => {
        if (!isLog || !axes) return undefined;
        const keys = [yKey, ...(stackKeys ?? []).map(band => band.key)];
        const values = series
            .flatMap(datum => keys.map(key => Number(datum?.[key])))
            .filter(value => Number.isFinite(value) && value > 0);
        if (!values.length) return undefined;
        const ticks: number[] = [];
        for (let e = Math.floor(Math.log10(Math.min(...values))); e <= Math.ceil(Math.log10(Math.max(...values))); e++) {
            ticks.push(10 ** e);
        }
        return ticks;
    })();

    // Built once and dropped into whichever chart body renders below, so the two
    // can't drift in domain or styling.
    const yAxisEl = (
        <YAxis
            hide={!axes}
            {...(isLog
                ? { scale: "log" as const, domain: [logBelow, logAbove], ticks: logTicks }
                : { domain: stacked ? [0, padAbove] : [padBelow, padAbove] })}
            tick={TICK_STYLE}
            tickFormatter={compactTick}
            axisLine={false}
            tickLine={false}
            width={36}
        />
    );

    const xAxisEl = axes ? (
        <XAxis
            dataKey={xKey}
            tick={TICK_STYLE}
            // Thins labels to what fits instead of overprinting them; a 90-day
            // series would otherwise try to print 90 dates.
            minTickGap={24}
            interval="preserveStartEnd"
            axisLine={false}
            tickLine={false}
            tickMargin={4}
        />
    ) : null;

    const chartMargin = { top: 2, right: axes ? 6 : 0, bottom: axes ? 0 : 2, left: 0 };

    // shrink-0: ResponsiveContainer measures its parent, and a flex column would
    // otherwise compress this box toward zero and collapse the chart.
    return (
        <div className={`w-full shrink-0 ${heightClass}`}>
            {series.length > 0 && (
                <ResponsiveContainer width="100%" height="100%">
                    {/* Vertical margin keeps the stroke off the clipping edge at
                        the series' min and max. */}
                    {stacked ? (
                        <ComposedChart data={series} margin={chartMargin}>
                            {yAxisEl}
                            {xAxisEl}
                            {CustomTooltip
                                ? <Tooltip content={<CustomTooltip />} cursor={{ stroke: "rgba(255,255,255,0.2)" }} />
                                : <Tooltip content={renderTooltip} cursor={{ stroke: "rgba(255,255,255,0.2)" }} />}
                            {banded && stackKeys!.map(band => (
                                <Area
                                    key={band.key}
                                    type="monotone"
                                    dataKey={band.key}
                                    stackId="bands"
                                    stroke="none"
                                    fill={band.color}
                                    fillOpacity={0.75}
                                    // stroke="none" would make a default dot
                                    // invisible, so its fill is set explicitly.
                                    dot={showDots ? { r: 2, strokeWidth: 0, fill: band.color } : false}
                                    isAnimationActive={false}
                                />
                            ))}
                            {/* Unstacked, but still FILLED: each band is its own area
                                from the axis floor up to its value, so the chart keeps
                                the solid look of the linear stacked version instead of
                                thinning to bare lines.
                                OPAQUE, deliberately. These areas OVERLAP (they don't
                                sum), so any transparency compounds where they cover
                                each other and every band reads as a blend of the ones
                                below rather than as its own category color. Opaque
                                fills occlude instead, and because `stackKeys` is
                                ordered largest-first each successive smaller band
                                paints over the one beneath — so the visible result is
                                contiguous solid regions, each bounded at its own
                                value, in its own legend color. */}
                            {bandLines && stackKeys!.map(band => (
                                <Area
                                    key={band.key}
                                    type="monotone"
                                    // A function dataKey so the FLOOR applies to the
                                    // plotted value only; the datum the tooltip reads
                                    // stays untouched.
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    dataKey={(datum: any) => logSafe(datum?.[band.key])}
                                    name={band.label ?? band.key}
                                    // No stackId — each area is independent. baseValue
                                    // is the log floor, below the rendered domain, so
                                    // the fill runs off the bottom edge rather than
                                    // stopping at the smallest band's value.
                                    baseValue={LOG_FLOOR}
                                    // No stroke: with opaque fills the boundary
                                    // between two regions is already a hard color
                                    // change, same as the linear stacked bands.
                                    stroke="none"
                                    fill={band.color}
                                    fillOpacity={1}
                                    dot={showDots ? { r: 2, strokeWidth: 0, fill: band.color } : false}
                                    activeDot={{ r: 2, strokeWidth: 0 }}
                                    isAnimationActive={false}
                                />
                            ))}
                            {/* Drawn last so it sits ON TOP. On a linear axis it
                                traces the top of the stack by construction — the
                                bands partition it — which is what makes the total
                                and its composition legible at once. On a log axis
                                it is simply the largest line. */}
                            <Line
                                type="monotone"
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                dataKey={isLog ? ((datum: any) => logSafe(datum?.[yKey])) : yKey}
                                name="total"
                                stroke={color}
                                strokeWidth={1.5}
                                dot={showDots ? { r: 2.5, strokeWidth: 0, fill: color } : false}
                                activeDot={{ r: 2.5, strokeWidth: 0 }}
                                isAnimationActive={false}
                            />
                        </ComposedChart>
                    ) : (
                        <AreaChart data={series} margin={chartMargin}>
                            <defs>
                                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            {yAxisEl}
                            {xAxisEl}
                            {CustomTooltip
                                ? <Tooltip content={<CustomTooltip />} cursor={{ stroke: "rgba(255,255,255,0.2)" }} />
                                : <Tooltip content={renderTooltip} cursor={{ stroke: "rgba(255,255,255,0.2)" }} />}
                            <Area
                                type="monotone"
                                dataKey={yKey}
                                stroke={color}
                                strokeWidth={1.5}
                                fill={`url(#${gradientId})`}
                                dot={showDots ? { r: 2.5, strokeWidth: 0, fill: color } : false}
                                activeDot={{ r: 2.5, strokeWidth: 0 }}
                                isAnimationActive={false}
                            />
                        </AreaChart>
                    )}
                </ResponsiveContainer>
            )}
        </div>
    );
};
