const Parser = require('rss-parser');
const parser = new Parser();
const google = require('googlethis'); 

// ✅ Boss ki Asli API Keys (Locked & Active)
const SERPER_API_KEY = "2696a75bf385577ff2b4798428dd24de8ce5ee51";
const TAVILY_API_KEY = "Tvly-dev-VpI8I-3XO9moaJNyUtvTz1tz5pVAHbWbpJHGxyxBXBngbCpv";

// ==========================================
// ENGINE 0: RSS FEEDS (100% Free - News Ke Liye)
// ==========================================
async function engine_RSS(query) {
    const isNewsQuery = query.toLowerCase().includes('news') || query.toLowerCase().includes('khabar') || query.toLowerCase().includes('latest') || query.toLowerCase().includes('aaj');
    
    if (!isNewsQuery) {
        throw new Error("Not a news query, skipping RSS.");
    }

    console.log("[Engine 0] RSS Feed check kar raha hoon...");
    const feedUrl = 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en';
    const feed = await parser.parseURL(feedUrl);
    
    let newsData = "LATEST NEWS FROM RSS FEED:\n";
    for (let i = 0; i < 3; i++) {
        if (feed.items[i]) {
            newsData += `- ${feed.items[i].title}\n`;
        }
    }
    return newsData;
}

// ==========================================
// ENGINE 1: WIKIPEDIA API (100% Free)
// ==========================================
async function engine_Wikipedia(query) {
    console.log("[Engine 1] Wikipedia par search kar raha hoon...");
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=2&namespace=0&format=json`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data[1] && data[1].length > 0 && data[3] && data[3].length > 0) {
        return `WIKIPEDIA DATA:\nTitle: ${data[1][0]}\nLink: ${data[3][0]}`;
    }
    throw new Error("Wikipedia par kuch nahi mila.");
}

// ==========================================
// ENGINE 2: GOOGLE SCRAPER (Free - googlethis package)
// ==========================================
async function engine_GoogleScraper(query) {
    console.log("[Engine 2] Free Google Scraper (googlethis) se try kar raha hoon...");
    const options = { page: 0, safe: false, additional_params: { hl: 'en' } };
    const searchResponse = await google.search(query, options);
    
    if (searchResponse && searchResponse.results && searchResponse.results.length > 0) {
        return searchResponse.results.slice(0, 3).map(r => `Title: ${r.title}\nInfo: ${r.description}`).join('\n\n');
    }
    throw new Error("Google scraper block ho gaya ya result nahi mila.");
}

// ==========================================
// ENGINE 3: SERPER.DEV (Fast Google Search API)
// ==========================================
async function engine_Serper(query) {
    console.log("[Engine 3] Serper API se Google search kar raha hoon...");
    const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query })
    });
    
    const data = await response.json();
    if (data.organic && data.organic.length > 0) {
        return data.organic.slice(0, 3).map(r => `Title: ${r.title}\nInfo: ${r.snippet}`).join('\n\n');
    }
    throw new Error("Serper API se koi result nahi aaya.");
}

// ==========================================
// ENGINE 4: TAVILY AI (Premium AI Search)
// ==========================================
async function engine_Tavily(query) {
    console.log("[Engine 4] Tavily AI se search kar raha hoon...");
    const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, query: query, search_depth: "basic" })
    });
    
    const data = await response.json();
    if (data.results && data.results.length > 0) {
        return data.results.slice(0, 3).map(r => `Title: ${r.title}\nInfo: ${r.content}`).join('\n\n');
    }
    throw new Error("Tavily se koi result nahi mila.");
}

// ==========================================
// MASTER FALLBACK LOOP (God-Mode Active - Reordered)
// ==========================================
async function doLiveSearch(query) {
    // ⚡ Serper aur Google Scraper ko aage kar diya hai taaki bhav/rate wale sawal turant pakde jayein
    const searchEngines = [engine_Serper, engine_GoogleScraper, engine_Wikipedia, engine_RSS, engine_Tavily];

    for (let i = 0; i < searchEngines.length; i++) {
        try {
            const data = await searchEngines[i](query);
            if (data) {
                console.log(`✅ Success! Data Engine ${i} se mil gaya.`);
                return data; 
            }
        } catch (error) {
            console.log(`⚠️ Engine ${i} Fail hua ya skip hua. Agle engine par ja raha hoon...`);
            continue; 
        }
    }
    
    return "Internet par koi taaza jankari nahi mili ya saare search engines down hain.";
}

module.exports = { doLiveSearch };
