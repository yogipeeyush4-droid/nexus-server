const express = require('express');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

app.get('/', (req, res) => {
  res.send('NexusForge Core is ONLINE!');
});

app.post('/api/swarm', async (req, res) => {
  const { command } = req.body || {};
  console.log(`[COMMAND]: ${command}`);
  
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: "You are NexusManager." },
          { role: "user", content: command || "Hello" }
        ]
      })
    });

    const data = await response.json();
    if (data.choices && data.choices.length > 0) {
      res.json({ status: "success", managerReply: data.choices[0].message.content });
    } else {
      res.json({ status: "success", managerReply: "AI core active, response received." });
    }
  } catch (err) {
    res.json({ status: "success", managerReply: "Shield active: " + err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("Listening on port " + PORT);
});
