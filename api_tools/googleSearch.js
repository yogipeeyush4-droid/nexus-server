// --- NEXUS BROWSER ENGINE CONNECTOR (STRICT MODE) ---
module.exports = async function(query) {
    console.log(`[SYSTEM] GoogleSearch Tool Triggered for query: "${query}"`);

    // Aapka live Codespace browser engine URL (Port 3000)
    const NEXUS_BROWSER_URL = 'https://bug-free-doodle-965rp797q5gjh4g9-3000.app.github.dev'; 

    try {
        console.log('[SEARCH] 🚀 Connecting to Nexus Browser Engine...');
        
        const response = await fetch(`${NEXUS_BROWSER_URL}/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query: query, maxResults: 3 })
        });
        
        if (response.ok) {
            const jsonResponse = await response.json();
            
            // Engine ke response format ke hisab se data nikalna
            if (jsonResponse.success && jsonResponse.data && jsonResponse.data.length > 0) {
                let formattedResults = jsonResponse.data.slice(0, 3).map((item, index) => {
                    return `Result ${index + 1}:\nTitle: ${item.title || "No Title"}\nInfo: ${item.snippet || "No Info"}`;
                }).join('\n\n');
                
                console.log('[SUCCESS] Data successfully fetched from Nexus Browser! 🎯');
                return `[100% APNE BROWSER SE AAYA DATA 🚀]:\n\n${formattedResults}`;
            } else {
                return "[APNA BROWSER]: Engine mast chala, par is query ka koi naya result nahi mila.";
            }
        } else {
            console.log(`[WARNING] Browser Engine HTTP Error: ${response.status}`);
            return `[BROWSER ERROR]: Engine tak baat nahi pahunchi. Status Code: ${response.status}`;
        }
    } catch (error) { 
        console.log(`[WARNING] Connection Failed: ${error.message}`);
        return `[BROWSER FAILED]: Engine offline hai ya connect nahi ho raha. Error: ${error.message}`; 
    }
};
