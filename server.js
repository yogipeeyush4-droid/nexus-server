const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send("NexusForge AI Node is ONLINE! 🚀");
});

app.post('/api/swarm', async (req, res) => {
  const { command } = req.body;
  console.log(`[CEO COMMAND]: ${command}`);
  
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b", // Verified active Groq model
        messages: [
          { role: "system", content: "You are Nexus, a highly intelligent and obedient AI assistant for the CEO of NexusForge. Reply in short, professional, and futuristic tone." },
          { role: "user", content: command }
        ]
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      const aiReply = data.choices[0].message.content;
      res.json({ status: "success", managerReply: aiReply });
    } else {
      res.json({ status: "error", managerReply: "AI Error: " + (data.error?.message || "Invalid response") });
    }

  } catch (error) {
    console.error("AI Error:", error);
    res.json({
      status: "error",
      managerReply: "AI Connection interrupted. System offline!"
    });
  }
});

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log("AI Node listening on port " + listener.address().port);
});
