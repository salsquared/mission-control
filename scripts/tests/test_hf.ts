async function run() {
    const res = await fetch('https://huggingface.co/api/daily_papers');
    const data = await res.json();
    console.log(JSON.stringify(data.slice(0, 2), null, 2));
}
run();
