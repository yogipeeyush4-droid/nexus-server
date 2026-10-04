const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send("NexusForge AI Swarm Core is ONLINE! 🚀");
});

app.post('/api/swarm', async (req, res) => {
  const { command } = req.body;
  console.log(`[CEO COMMAND]: ${command}`);
  
  try {
    // Groq AI ko Swarm orchestration ke liye prompt bhejna
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { 
            role: "system", 
            content: "You are NexusManager, the lead AI of NexusForge Swarm. Coordinate with your specialized agents (@Design_AI, @Coder_DB_AI, @Security_AI, @Tester_AI) to break down the CEO's command. Provide a structured, multi-agent status and execution response in a futuristic, professional tone." 
          },
          { role: "user", content: command }
        ]
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      const aiReply = data.choices[0].message.content;
      res.json({ 
        status: "success", 
        managerReply: `[SWARM ACTIVE] ${aiReply}` 
      });
    } else {
      res.json({ status: "error", managerReply: "Swarm Error: " + (data.error?.message || "Invalid response") });
    }

  } catch (error) {
    console.error("Swarm Error:", error);
    res.json({
      status: "error",
      managerReply: "AI Swarm Connection interrupted. System offline!"
    });
  }
});

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log("Swarm Core listening on port " + listener.address().port);
});
