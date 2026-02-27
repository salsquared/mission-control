async function runTestSS() {
    // Top cited survey/review papers in AI
    const res = await fetch('https://api.semanticscholar.org/graph/v1/paper/search?query=artificial+intelligence+review+survey&limit=5&fields=title,authors,abstract,citationCount,year,url,externalIds&year=2020-2026');
    console.log("Review Papers Request Status:", res.status);
    const data = await res.json();
    console.log(JSON.stringify(data.data?.map((p: any) => ({ title: p.title, year: p.year, citations: p.citationCount })), null, 2));

    // Historical papers in AI
    const res2 = await fetch('https://api.semanticscholar.org/graph/v1/paper/search?query=artificial+intelligence+neural&limit=5&fields=title,authors,abstract,citationCount,year,url,externalIds&year=1950-2015');
    console.log("Historical Papers Request Status:", res2.status);
    const data2 = await res2.json();
    console.log(JSON.stringify(data2.data?.map((p: any) => ({ title: p.title, year: p.year, citations: p.citationCount })), null, 2));
}
runTestSS();

export { };
