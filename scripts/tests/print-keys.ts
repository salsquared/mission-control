async function printKeys() {
    try {
        const url = "https://datasets-server.huggingface.co/search?dataset=open-llm-leaderboard%2Fcontents&config=default&split=train&query=Llama-3.1-70B-Instruct&length=1";
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            if (data.rows && data.rows.length > 0) {
                console.log("Available Metrics/Columns:");
                for (const key of Object.keys(data.rows[0].row)) {
                    console.log(`- ${key}: ${typeof data.rows[0].row[key]} (Example: ${data.rows[0].row[key]})`);
                }
            }
        }
    } catch (e) { console.error(e); }
}
printKeys();
