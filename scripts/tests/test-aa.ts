async function testArtificialAnalysis() {
    try {
        const url = "https://artificialanalysis.ai/api/v1/models";
        const res = await fetch(url);
        if (!res.ok) {
            console.log("Failed:", res.status, await res.text());
            return;
        }
        const data = await res.json();
        console.log("Models:", data.length);
        if (data.length > 0) {
            const sample = data[0];
            console.log("Sample:", Object.keys(sample));
            console.log(JSON.stringify(sample, null, 2));
        }
    } catch (e) { console.error(e); }
}
testArtificialAnalysis();
