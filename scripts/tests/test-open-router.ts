import fs from 'fs';
async function run() {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const data = await res.json();
    console.log(Object.keys(data.data[0]));
    const withMetrics = data.data.filter((m: any) => m.architecture || m.context_length);
    console.log("With metrics:", withMetrics.length);
    // Find deepseek v3 or llama 3
    const deepseek = data.data.find((m: any) => m.id.includes("deepseek/deepseek-r1"));
    console.log(deepseek);
}
run();
