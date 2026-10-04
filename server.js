const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Server zinda hai ya nahi, yeh check karne ke liye
app.get('/', (req, res) => {
  res.send("NexusForge Master Node is ONLINE! 🚀");
});

// War Room se command receive karne ka rasta
app.post('/api/swarm', async (req, res) => {
  const { command } = req.body;
  console.log(`[CEO COMMAND RECEIVED]: ${command}`);
  
  res.json({
    status: "success",
    managerReply: `Directive Locked: "${command}". Deploying Swarm remotely from Cloud...`
  });
});

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log("Master Node listening on port " + listener.address().port);
});
