import type { CompanyAdapter } from './adapter';
import aerojetRocketdyne from './aerojet-rocketdyne';
import amd from './amd';
import anthropic from './anthropic';
import apex from './apex';
import apple from './apple';
import arianegroup from './arianegroup';
import arm from './arm';
import baidu from './baidu';
import blueCanyon from './blue-canyon';
import blueOrigin from './blue-origin';
import boeing from './boeing';
import broadcom from './broadcom';
import bytedance from './bytedance';
import cerebras from './cerebras';
import cnsa from './cnsa';
import csa from './csa';
import deepmind from './deepmind';
import deepseek from './deepseek';
import esa from './esa';
import firefly from './firefly';
import globalfoundries from './globalfoundries';
import googleAi from './google-ai';
import groq from './groq';
import hadrian from './hadrian';
import huggingface from './huggingface';
import intel from './intel';
import intelFoundry from './intel-foundry';
import isro from './isro';
import jaxa from './jaxa';
import lockheedMartin from './lockheed-martin';
import meta from './meta';
import micron from './micron';
import microsoft from './microsoft';
import mistral from './mistral';
import nasa from './nasa';
import northropGrumman from './northrop-grumman';
import nvidia from './nvidia';
import openai from './openai';
import qualcomm from './qualcomm';
import redwire from './redwire';
import relativity from './relativity';
import rfa from './rfa';
import rocketlab from './rocketlab';
import roscosmos from './roscosmos';
import samsungFoundries from './samsung-foundries';
import semianalysis from './semianalysis';
import smic from './smic';
import spacex from './spacex';
import stoke from './stoke';
import tsmc from './tsmc';
import ula from './ula';
import umc from './umc';
import ursaMajor from './ursa-major';
import xai from './xai';
import xona from './xona';

export type { CompanyAdapter };
export { TTL_STANDARD, TTL_LOW_VOLUME, TTL_VERY_LOW } from './custom-fetchers';

export const ADAPTERS: CompanyAdapter[] = [
    aerojetRocketdyne,
    amd,
    anthropic,
    apex,
    apple,
    arianegroup,
    arm,
    baidu,
    blueCanyon,
    blueOrigin,
    boeing,
    broadcom,
    bytedance,
    cerebras,
    cnsa,
    csa,
    deepmind,
    deepseek,
    esa,
    firefly,
    globalfoundries,
    googleAi,
    groq,
    hadrian,
    huggingface,
    intel,
    intelFoundry,
    isro,
    jaxa,
    lockheedMartin,
    meta,
    micron,
    microsoft,
    mistral,
    nasa,
    northropGrumman,
    nvidia,
    openai,
    qualcomm,
    redwire,
    relativity,
    rfa,
    rocketlab,
    roscosmos,
    samsungFoundries,
    semianalysis,
    smic,
    spacex,
    stoke,
    tsmc,
    ula,
    umc,
    ursaMajor,
    xai,
    xona,
];

const ALIASES: Record<string, string> = {
    'rocket-lab': 'rocketlab',
    'google': 'deepmind',
};

export function resolveCompanyId(input: string): string {
    const lower = input.toLowerCase();
    return ALIASES[lower] || lower;
}

export function getAdapter(id: string): CompanyAdapter | undefined {
    return ADAPTERS.find(a => a.id === id || a.id === id.toLowerCase());
}

export function getAdaptersByView(view: 'space' | 'ai'): CompanyAdapter[] {
    return ADAPTERS.filter(a => a.view === view || a.view === 'both');
}

export function getCategoriesForView(view: 'space' | 'ai'): string[] {
    return [...new Set(getAdaptersByView(view).map(a => a.category))];
}

export function getUpstreamHost(adapter: CompanyAdapter): string | null {
    return adapter.upstreamHost ?? null;
}
