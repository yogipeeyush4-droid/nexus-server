const res = await fetch(`${NEXUS_BROWSER_URL}/search`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, maxResults: 3 })
});

console.log("STATUS =", res.status);

const raw = await res.text();

console.log("RAW RESPONSE =", raw);

return raw;
