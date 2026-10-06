async function googleSearch(query) {
    try {
        console.log(`\n🔍 [AI Tool] Nexus Engine se search kar raha hoon: "${query}"`);
        
        // Aapke PM2 wale background browser engine (Port 3000) par request bhej raha hai
        const response = await fetch('http://localhost:3000/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query, maxResults: 5 }) // 5 results mangayega
        });

        const result = await response.json();
        
        if (result.success) {
            console.log(`✅ [AI Tool] Engine ne ${result.data.length} results diye!`);
            return result.data; 
        } else {
            console.error("❌ [AI Tool] Engine Error:", result.error);
            return "Search fail ho gaya. Engine mein issue hai.";
        }
    } catch (error) {
        console.error("❌ [AI Tool] Connection Failed:", error.message);
        return "Browser engine port 3000 par band hai ya connect nahi ho pa raha.";
    }
}

module.exports = { googleSearch };
