async function testAI() {
    const res = await fetch("http://localhost:3000/api/ai");
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("AI should be an array");
    if (data.length > 0) {
        const item = data[0];
        if (typeof item.id !== "string") throw new Error("AI item.id should be string");
        if (typeof item.title !== "string") throw new Error("AI item.title should be string");
        if (typeof item.url !== "string") throw new Error("AI item.url should be string");
        if (item.source !== "Hacker News") throw new Error("AI item.source should be 'Hacker News'");
        if (typeof item.publishedAt !== "string") throw new Error("AI item.publishedAt should be string");
        if (typeof item.author !== "string") throw new Error("AI item.author should be string");
    }
    console.log("✅ AI Dashboard schema passed");
}

async function testFinance() {
    const res = await fetch("http://localhost:3000/api/finance");
    const data = await res.json();
    if (!Array.isArray(data.top100)) throw new Error("Finance top100 should be an array");
    if (data.top100.length > 0) {
        const t100 = data.top100[0];
        if (typeof t100.id !== "string") throw new Error("Finance top100.id should be string");
        if (typeof t100.name !== "string") throw new Error("Finance top100.name should be string");
        if (typeof t100.symbol !== "string") throw new Error("Finance top100.symbol should be string");
        if (typeof t100.marketCapRank !== "number") throw new Error("Finance top100.marketCapRank should be number");
        if (typeof t100.image !== "string") throw new Error("Finance top100.image should be string");
        if (typeof t100.currentPrice !== "number") throw new Error("Finance top100.currentPrice should be number");
        if (typeof t100.priceChange24h !== "number" && t100.priceChange24h !== null) throw new Error("Finance top100.priceChange24h should be number or null");
        if (typeof t100.marketCap !== "number") throw new Error("Finance top100.marketCap should be number");
    }

    if (typeof data.prices.bitcoin.usd !== "number") throw new Error("Finance prices.bitcoin.usd should be number");
    if (typeof data.prices.ethereum.usd !== "number") throw new Error("Finance prices.ethereum.usd should be number");
    if (typeof data.prices.solana.usd !== "number") throw new Error("Finance prices.solana.usd should be number");

    if (typeof data.fees.fastestFee !== "number") throw new Error("Finance fees.fastestFee should be number");
    if (typeof data.timestamp !== "number") throw new Error("Finance timestamp should be number");

    console.log("✅ Finance Data schema passed");
}

async function testFinanceHistory() {
    const res = await fetch("http://localhost:3000/api/finance/history?coin=bitcoin&range=1");
    const data = await res.json();
    if (!Array.isArray(data.history)) throw new Error("Finance History should be an array");
    if (data.history.length > 0) {
        const h = data.history[0];
        if (typeof h.time !== "number") throw new Error("Finance History time should be number");
        if (typeof h.price !== "number") throw new Error("Finance History price should be number");
    }
    console.log("✅ Finance History schema passed");
}

async function testSpace() {
    const res = await fetch("http://localhost:3000/api/space");
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("Space should be an array");
    if (data.length > 0) {
        const item = data[0];
        // id could be number or string based on API version, but mostly number for SNAPI v4
        if (typeof item.id !== "number" && typeof item.id !== "string") throw new Error("Space item.id should be number or string");
        if (typeof item.title !== "string") throw new Error("Space item.title should be string");
        if (typeof item.url !== "string") throw new Error("Space item.url should be string");
        if (typeof item.image_url !== "string") throw new Error("Space item.image_url should be string");
        if (typeof item.news_site !== "string") throw new Error("Space item.news_site should be string");
    }
    console.log("✅ Space News schema passed");
}

async function testLaunches() {
    const res = await fetch("http://localhost:3000/api/space/launches");
    const data = await res.json();

    if (!Array.isArray(data)) throw new Error("Launches should be an array");
    if (data.length > 0) {
        const item = data[0];
        if (typeof item.id !== "string") throw new Error("Launches item.id should be string");
        if (typeof item.name !== "string") throw new Error("Launches item.name should be string");
        if (typeof item.net !== "string") throw new Error("Launches item.net should be string");
        if (typeof item.status !== "object") throw new Error("Launches item.status should be object");
        if (typeof item.status.id !== "number") throw new Error("Launches item.status.id should be number");
        if (typeof item.status.name !== "string") throw new Error("Launches item.status.name should be string");
        if (typeof item.status.abbrev !== "string") throw new Error("Launches item.status.abbrev should be string");
    }
    console.log("✅ Rocket Launches schema passed");
}

async function testSolar() {
    const res = await fetch("http://localhost:3000/api/space/solar");
    const data = await res.json();
    if (typeof data.status !== "string") throw new Error("Solar status should be string");
    if (typeof data.xray_flux !== "string") throw new Error("Solar xray_flux should be string");
    if (typeof data.updated_at !== "string") throw new Error("Solar updated_at should be string");
    console.log("✅ Solar Activity schema passed");
}

async function testSatellites() {
    const res = await fetch("http://localhost:3000/api/space/satellites");
    // Since some schemas could error if satellite API is down or just planned, let's catch it softly or throw.
    // Based on docs, it is "Planned", but if it's returning real data we will assert against it.
    const data = await res.json();
    if (data.error) {
        console.warn("⚠️ Satellites data unavailable or returned an error:", data.error);
        return;
    }

    if (typeof data.total_active !== "number") throw new Error("Satellites total_active should be number");
    if (typeof data.orbits !== "object") throw new Error("Satellites orbits should be an object");
    if (typeof data.orbits.LEO !== "number") throw new Error("Satellites orbits.LEO should be number");
    if (typeof data.orbits.MEO !== "number") throw new Error("Satellites orbits.MEO should be number");
    if (typeof data.orbits.GEO !== "number") throw new Error("Satellites orbits.GEO should be number");
    if (typeof data.orbits.SSO !== "number") throw new Error("Satellites orbits.SSO should be number");
    if (typeof data.constellations !== "object") throw new Error("Satellites constellations should be an object");
    if (typeof data.constellations.starlink !== "number") throw new Error("Satellites constellations.starlink should be number");
    console.log("✅ Satellites schema passed");
}

async function testMoon() {
    const res = await fetch("http://localhost:3000/api/space/moon");
    const data = await res.json();

    if (!Array.isArray(data.weekly_cycles)) throw new Error("Moon weekly_cycles should be an array");
    if (data.weekly_cycles.length > 0) {
        const cycle = data.weekly_cycles[0];
        if (typeof cycle.date !== "string") throw new Error("Moon weekly_cycles[].date should be string");
        if (typeof cycle.phase !== "string") throw new Error("Moon weekly_cycles[].phase should be string");
        if (typeof cycle.illumination !== "number") throw new Error("Moon weekly_cycles[].illumination should be number");
    }

    if (data.next_phenomenon) {
        if (typeof data.next_phenomenon.type !== "string") throw new Error("Moon next_phenomenon.type should be string");
        if (typeof data.next_phenomenon.date !== "string") throw new Error("Moon next_phenomenon.date should be string");
        if (typeof data.next_phenomenon.description !== "string") throw new Error("Moon next_phenomenon.description should be string");
    }

    if (typeof data.updated_at !== "string") throw new Error("Moon updated_at should be string");
    console.log("✅ Moon schema passed");
}

async function runTests() {
    try {
        console.log("Running API Schema Validation tests against localhost...");
        await testAI();
        await testFinance();
        await testFinanceHistory();
        await testSpace();
        await testLaunches();
        await testSolar();
        await testSatellites();
        await testMoon();
        console.log("🚀 All API Schema validations passed!");
    } catch (error) {
        console.error("❌ Test failed:", error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

runTests();
