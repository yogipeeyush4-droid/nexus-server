// MASTER SEARCH TOOL - 3 APIs + BROWSER FALLBACK
module.exports = async function(query) {
    console.log(`[SYSTEM] Search command received: ${query}`);

    // 👉 1. YAHAN APNI API KEYS DAALNI HAIN (Agar blank rahne doge toh skip ho jayega)
    const GOOGLE_API_KEY = ''; // Google Custom Search Key
    const GOOGLE_CX = '';      // Google Custom Search Engine ID
    
    const SERPER_API_KEY = ''; // Serper.dev (Google Search API) Key
    
    const TAVILY_API_KEY = ''; // Tavily Search API Key

    // 👉 2. YAHAN APNA COPY KIYA HUA BROWSER LINK DAALO
    const NEXUS_BROWSER_URL = 'YAHAN_APNA_COPY_KIYA_HUA_LINK_PASTE_KARO'; 

    // --- LEVEL 1: GOOGLE CUSTOM SEARCH API ---
    if (GOOGLE_API_KEY && GOOGLE_CX) {
        console.log('[SEARCH] Level 1: Google API try kar raha hoon...');
        try {
            const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.items) return formatResults(data.items, "Google API");
            }
        } catch (e) { console.log('[WARNING] Google API Failed.'); }
    }

    // --- LEVEL 2: SERPER.DEV API (Alternate Google Search) ---
    if (SERPER_API_KEY) {
        console.log('[SEARCH] Level 2: Serper API try kar raha hoon...');
        try {
            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.organic) return formatResults(data.organic, "Serper API");
            }
        } catch (e) { console.log('[WARNING] Serper API Failed.'); }
    }

    // --- LEVEL 3: TAVILY SEARCH API ---
    if (TAVILY_API_KEY) {
        console.log('[SEARCH] Level 3: Tavily API try kar raha hoon...');
        try {
            const res = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: TAVILY_API_KEY, query: query })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.results) return formatResults(data.results, "Tavily API");
            }
        } catch (e) { console.log('[WARNING] Tavily API Failed.'); }
    }

    // --- LEVEL 4: APNA KHUD KA BROWSER ENGINE (APIs fail hone par yahan aayega) 🚀 ---
    if (NEXUS_BROWSER_URL && NEXUS_BROWSER_URL !== 'YAHAN_APNA_COPY_KIYA_HUA_LINK_PASTE_KARO') {
        console.log('[SEARCH] Level 4: APIs fail! Apna Nexus Browser Engine chal raha hai... 🚀');
        try {
            const res = await fetch(`${NEXUS_BROWSER_URL}/search?q=${encodeURIComponent(query)}`);
            if (res.ok) {
                const data = await res.json();
                let resultText = data.results ? formatResults(data.results, "NEXUS BROWSER") : JSON.stringify(data).substring(0, 1000);
                return `[APNA BROWSER ENGINE]:\n\n${resultText}`;
            }
        } catch (e) { 
            console.log(`[WARNING] Browser Engine Failed: ${e.message}`); 
        }
    }

    // --- LEVEL 5: FREE OPEN WEB SYSTEM (Backup RSS / Wiki) ---
    console.log('[SEARCH] Level 5: Sab fail hua, Apna basic Open Web try kar raha hoon...');
    try {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
        const rssRes = await fetch(rssUrl);

        if (rssRes.ok) {
            const xmlData = await rssRes.text();
            const items = xmlData.match(/<item>([\s\S]*?)<\/item>/g);
            if (items && items.length > 0) {
                let finalResult = "[APNA SYSTEM - LIVE NEWS]:\n\n";
                for (let i = 0; i < Math.min(3, items.length); i++) {
                    const titleMatch = items[i].match(/<title>(.*?)<\/title>/);
                    if (titleMatch) {
                        let cleanTitle = titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');
                        finalResult += `👉 ${cleanTitle}\n`;
                    }
                }
                return finalResult;
            }
        }
    } catch (e) {
        console.log(`[ERROR] Basic System fail hua: ${e.message}`);
    }

    return "Boss, main internet connect nahi kar paaya. Saare backup system fail ho gaye.";
};

// Formatting helper (Sabhi API format ko handle karne ke liye)
function formatResults(items, source) {
    if (!items || items.length === 0) return "Kuch nahi mila.";
    let text = items.slice(0, 3).map(i => {
        let title = i.title || i.name || "Title nahi mila";
        let info = i.snippet || i.content || "Info nahi mili";
        return `Title: ${title}\nInfo: ${info}`;
    }).join('\n\n');
    return `[${source}]:\n${text}`;
}
