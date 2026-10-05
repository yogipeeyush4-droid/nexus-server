module.exports = async function(query) {
    console.log(`[SYSTEM] Searching via Nexus Browser for: "${query}"`);
    // Naya Google Cloud Shell URL yahan set kar diya hai
    const NEXUS_BROWSER_URL = 'https://3000-cs-5a4b3fb1-a13b-4d10-861a-5974d7834863.cs-asia-southeast1-fork.cloudshell.dev'; 

    try {
        const response = await fetch(`${NEXUS_BROWSER_URL}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query, maxResults: 3 })
        });

        if (response.ok) {
            const jsonResponse = await response.json();
            if (jsonResponse.success && jsonResponse.data && jsonResponse.data.length > 0) {
                let formattedResults = jsonResponse.data.map((item, index) => {
                    return `Result ${index + 1}:\nTitle: ${item.title}\nInfo: ${item.snippet}`;
                }).join('\n\n');
                return `[100% APNE BROWSER SE AAYA DATA 🚀]:\n\n${formattedResults}`;
            } else {
                return "[BROWSER]: Engine chala, par koi naya result nahi mila.";
            }
        } else {
            return `[BROWSER ERROR]: Status Code: ${response.status}`;
        }
    } catch (error) { 
        return `[BROWSER FAILED]: Error: ${error.message}`; 
    }
};
