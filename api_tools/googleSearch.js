// --- NEXUS BROWSER ENGINE CONNECTOR (JP DEBUGGING MODE) ---
module.exports = async function(query) {
    console.log(`[JP-DEBUG] ----------------------------------------`);
    console.log(`[JP-DEBUG] Step 1: Search tool trigger hua. Query: "${query}"`);

    const NEXUS_BROWSER_URL = 'https://bug-free-doodle-965rp797q5gjh4g9-3000.app.github.dev'; 

    try {
        console.log(`[JP-DEBUG] Step 2: Fetch request bhej rahe hain URL par: ${NEXUS_BROWSER_URL}/search`);
        
        const response = await fetch(`${NEXUS_BROWSER_URL}/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query: query, maxResults: 3 })
        });
        
        console.log(`[JP-DEBUG] Step 3: Server se response status mila: ${response.status} (${response.statusText})`);

        if (response.ok) {
            const jsonResponse = await response.json();
            console.log(`[JP-DEBUG] Step 4: Response JSON successfully read ho gaya.`);
            
            // Checking data format
            if (jsonResponse.success && jsonResponse.data && jsonResponse.data.length > 0) {
                let formattedResults = jsonResponse.data.slice(0, 3).map((item, index) => {
                    return `Result ${index + 1}:\nTitle: ${item.title || "No Title"}\nInfo: ${item.snippet || "No Info"}`;
                }).join('\n\n');
                
                console.log(`[JP-DEBUG] Step 5: Data successfully format ho gaya! 🚀`);
                return `[100% APNE BROWSER SE AAYA DATA (JP DEBUG) 🚀]:\n\n${formattedResults}`;
            } else {
                console.log(`[JP-DEBUG] Warning: Response OK tha par data format match nahi hua ya array khali hai.`);
                return `[JP DEBUG WARNING]: Engine chala par data nahi mila. Raw response: ${JSON.stringify(jsonResponse)}`;
            }
        } else {
            const errorText = await response.text();
            console.log(`[JP-DEBUG] Error: HTTP status fail ho gaya. Details: ${errorText}`);
            return `[JP DEBUG ERROR]: Browser engine ne error diya. Status: ${response.status}, Detail: ${errorText}`;
        }
    } catch (error) { 
        console.log(`[JP-DEBUG] Critical Exception: Connection poori tarah fail ho gaya. Error: ${error.message}`);
        return `[JP DEBUG FAILED]: Engine tak request gayi hi nahi ya network error hai. Reason: ${error.message}`; 
    }
};
