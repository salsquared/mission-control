import { Client } from "@gradio/client";

async function run() {
    const app = await Client.connect("lmsys/chatbot-arena-leaderboard");
    console.log(await app.view_api());
}
run();
