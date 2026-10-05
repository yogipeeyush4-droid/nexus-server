// --- STRICT NEXUS BROWSER CONNECTOR ---
module.exports = async function(query) {
    console.log(`[SYSTEM] Searching via Nexus Browser for: "${query}"`);

    // Aapki exact live link jo aapne abhi di hai
    const NEXUS_BROWSER_URL = 'https://bug-free-doodle-965rp797q5gjh4g9-3000.app.github.dev'; 

    try {
        const response = await fetch(`${NEXUS_BROWSER_URL}/api/swarm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: query })
        });
        
        if (response.ok) {
            const data = await response.json();
            return `[100% APNE BROWSER SE AAYA DATA 🚀]:\n\n${data.managerReply || JSON.stringify(data)}`;
        } else {
            return `[BROWSER ERROR]: Status Code: ${response.status}`;
        }
    } catch (error) { 
        return `[BROWSER FAILED]: Error: ${error.message}`; 
    }
};
