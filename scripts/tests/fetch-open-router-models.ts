async function testSearch() {
    try {
        const url = "https://datasets-server.huggingface.co/search?dataset=open-llm-leaderboard%2Fcontents&config=default&split=train&query=Llama-3";
        const response = await fetch(url);
        console.log("Search Status:", response.status);
        if (response.ok) {
            const data = await response.json();
            console.log("Search rows:", data.rows?.length);
            if (data.rows && data.rows.length > 0) {
                console.log("Sample 1:", data.rows[0].row.fullname, data.rows[0].row['Average ⬆️']);
            }
        } else {
            console.log(await response.text());
        }
    } catch (e) { console.error(e); }
}
testSearch();
