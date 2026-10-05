// STRICT BROWSER CHECK MODE - No Fallbacks!
module.exports = async function(query) {
    console.log(`[SYSTEM] Strict Check Mode: Searching for "${query}"`);

    // Aapki nayi live browser link
    const NEXUS_BROWSER_URL = 'https://bug-free-doodle-965rp797q5gjh4g9-34127.app.github.dev'; 

    try {
        console.log('[SEARCH] 🚀 Seedha Nexus Browser par ja raha hai...');
        
        const res = await fetch(`${NEXUS_BROWSER_URL}/search?q=${encodeURIComponent(query)}`);
        
        if (res.ok) {
            const data = await res.json();
            
            if (data.results && data.results.length > 0) {
                let resultText = data.results.slice(0, 3).map(i => {
                    return `Title: ${i.title || "No Title"}\nInfo: ${i.snippet || "No Info"}`;
                }).join('\n\n');
                
                // Yeh tag saboot hai ki data sirf aapke browser se aaya hai
                return `[100% APNE BROWSER SE AAYA DATA 🚀]:\n\n${resultText}`;
            } else {
                return "[APNA BROWSER]: Engine mast chala, par is query ka koi result nahi mila.";
            }
        } else {
            console.log(`[WARNING] HTTP Error: ${res.status}`);
            return `[BROWSER ERROR]: Apne engine tak baat nahi pahunchi. Status Code: ${res.status}`;
        }
    } catch (e) { 
        console.log(`[WARNING] Failed: ${e.message}`);
        return `[BROWSER FAILED]: Engine offline hai ya connect nahi ho raha. Error: ${e.message}`; 
    }
};
