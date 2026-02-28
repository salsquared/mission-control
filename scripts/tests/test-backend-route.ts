// verify the backend logic
import { GET } from "../../app/api/ai/llmleaderboard/route";

async function testRoute() {
    console.log("Testing route...");
    try {
        const res = await GET();
        const data = await res.json();
        console.log("Top 3 models:", data.slice(0, 3));
    } catch (e) {
        console.error(e);
    }
}
testRoute();
