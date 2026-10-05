// MASTER SEARCH TOOL - APNA KHUD KA SYSTEM + API FALLBACK
module.exports = async function(query) {
    console.log(`[SYSTEM] Search command received: ${query}`);

    // Baad mein jab man kare, yahan API key daal denge
    const TAVILY_API_KEY = ''; 

    // --- LEVEL 1: Tavily API (Abhi band hai kyunki key nahi hai) ---
    if (TAVILY_API_KEY) {
        try {
            console.log('[SEARCH] Level 1: API try kar raha hoon...');
            const res = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: TAVILY_API_KEY, query: query })
            });
            if (res.ok) {
                const data = await res.json();
                return formatResults(data.results, "Tavily API");
            }
        } catch (e) { console.log('[WARNING] API Failed.'); }
    }

    // --- LEVEL 2: APNA KHUD KA SYSTEM (Unblockable RSS / Wiki) ---
    console.log('[SEARCH] Level 2: Apna khud ka Open Web System try kar raha hoon...');
    try {
        // 1. Pehle hum Open News RSS check karenge (News ke liye best)
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
        const rssRes = await fetch(rssUrl);

        if (rssRes.ok) {
            const xmlData = await rssRes.text();
            
            // XML se sirf Title nikalne ka jadoo
            const items = xmlData.match(/<item>([\s\S]*?)<\/item>/g);
            
            if (items && items.length > 0) {
                let finalResult = "[APNA SYSTEM - LIVE NEWS]:\n\n";
                // Top 3 news nikalenge
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
        
        // 2. Agar news mein kuch nahi mila, toh Wikipedia API (100% Free & Open)
        console.log('[SEARCH] News nahi mili, Wikipedia check kar raha hoon...');
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json`;
        const wikiRes = await fetch(wikiUrl);
        
        if (wikiRes.ok) {
            const wikiData = await wikiRes.json();
            if (wikiData[1] && wikiData[1].length > 0) {
                let finalResult = "[APNA SYSTEM - WIKIPEDIA]:\n\n";
                for (let i = 0; i < wikiData[1].length; i++) {
                    finalResult += `👉 Title: ${wikiData[1][i]}\nInfo: ${wikiData[2][i]}\n\n`;
                }
                return finalResult;
            }
        }

    } catch (e) {
        console.log(`[ERROR] Apna System fail hua: ${e.message}`);
    }

    return "Boss, apna backup system aur APIs dono ko kuch nahi mila.";
};

// Formatting helper
function formatResults(items, source) {
    if (!items || items.length === 0) return "Kuch nahi mila.";
    let text = items.slice(0, 3).map(i => `Title: ${i.title || i.name}\nInfo: ${i.content || i.snippet}`).join('\n\n');
    return `[${source}]:\n${text}`;
}
