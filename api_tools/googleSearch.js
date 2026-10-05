// MASTER SEARCH TOOL - DIRECT BROWSER TEST MODE
module.exports = async function(query) {
    console.log(`[SYSTEM] Search command received: ${query}`);

    // Aapka Codespace Browser URL
    const NEXUS_BROWSER_URL = 'https://automatic-rotary-phone-jr7vxj5j4q99fp7rw-3000.app.github.dev'; 

    // --- DIRECT LEVEL 1: APNA BROWSER ENGINE 🚀 ---
    if (NEXUS_BROWSER_URL) {
        console.log('[SEARCH] Level 1: Seedha Nexus Browser Engine par bhej raha hoon... 🚀');
        try {
            const res = await fetch(`${NEXUS_BROWSER_URL}/search?q=${encodeURIComponent(query)}`);
            if (res.ok) {
                const data = await res.json();
                let resultText = data.results ? formatResults(data.results, "NEXUS BROWSER") : JSON.stringify(data).substring(0, 1000);
                return `[APNA BROWSER ENGINE]:\n\n${resultText}`;
            } else {
                console.log(`[WARNING] Browser Engine HTTP Error: ${res.status}`);
            }
        } catch (e) { 
            console.log(`[WARNING] Browser Engine Failed: ${e.message}`); 
        }
    }

    // --- FALLBACK: BASIC SYSTEM ---
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
    } catch (e) {}

    return "Boss, browser engine tak request nahi pahunch payi.";
};

// Formatting helper
function formatResults(items, source) {
    if (!items || items.length === 0) return "Kuch nahi mila.";
    let text = items.slice(0, 3).map(i => {
        let title = i.title || i.name || "Title nahi mila";
        let info = i.snippet || i.content || "Info nahi mili";
        return `Title: ${title}\nInfo: ${info}`;
    }).join('\n\n');
    return `[${source}]:\n${text}`;
}
