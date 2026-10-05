
// MASTER SEARCH TOOL - WATERFALL SYSTEM (Fallback Routing)
module.exports = async function(query) {
    console.log(`[SYSTEM] Search command received: ${query}`);

    // Yahan hum future mein apni API keys daalenge
    const GOOGLE_API_KEY = ''; 
    const GOOGLE_CX_ID = ''; 
    const TAVILY_API_KEY = '';
    const SERPAPI_KEY = '';

    // --- LEVEL 1: Google Official API ---
    if (GOOGLE_API_KEY && GOOGLE_CX_ID) {
        try {
            console.log('[SEARCH] Level 1: Google Official API try kar raha hoon...');
            const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX_ID}&q=${encodeURIComponent(query)}`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                return formatResults(data.items, "Google Official");
            }
        } catch (e) { console.log('[WARNING] Level 1 Failed.'); }
    }

    // --- LEVEL 2: Tavily API ---
    if (TAVILY_API_KEY) {
        try {
            console.log('[SEARCH] Level 2: Tavily API try kar raha hoon...');
            const res = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: TAVILY_API_KEY, query: query })
            });
            if (res.ok) {
                const data = await res.json();
                return formatResults(data.results, "Tavily");
            }
        } catch (e) { console.log('[WARNING] Level 2 Failed.'); }
    }

    // --- LEVEL 3 & 4: Unlimited Free Jugaad (Human Spoofing) ---
    // Agar upar ki keys nahi hain ya limits khatam ho gayi hain, toh yeh chalega
    try {
        console.log('[SEARCH] Level 4: Unlimited Free (Human Mode) try kar raha hoon...');
        
        // "Bhes Badalna" - Google ko lagega asli insaan Windows/Chrome chala raha hai
        const humanHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5"
        };

        // Note: Direct Google fetch ko kabhi-kabhi block kar deta hai, 
        // isliye hum backup search engine (DuckDuckGo HTML) use kar rahe hain jo block nahi karta
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: humanHeaders });
        
        if (res.ok) {
            const html = await res.text();
            // Basic HTML scraping (Title aur description nikalna)
            const snippetMatch = html.match(/<a class="result__snippet[^>]*>(.*?)<\/a>/gi);
            if (snippetMatch && snippetMatch.length > 0) {
                // HTML tags saaf karke AI ko dena
                const cleanText = snippetMatch.slice(0, 3).map(tag => tag.replace(/(<([^>]+)>)/gi, "")).join('\n\n');
                return `[LIVE WEB RESULTS (Unlimited)]:\n${cleanText}`;
            }
        }
    } catch (e) { 
        console.log(`[ERROR] Unlimited Mode Failed: ${e.message}`); 
    }

    return "Boss, sabhi search raste band hain ya internet error hai.";
};

// Helper function result set karne ke liye
function formatResults(items, source) {
    if (!items || items.length === 0) return "Kuch nahi mila.";
    let text = items.slice(0, 3).map(i => `Title: ${i.title || i.name}\nInfo: ${i.snippet || i.content}`).join('\n\n');
    return `[LIVE WEB RESULTS (${source})]:\n${text}`;
}
