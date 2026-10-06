// telegramBot.js - Telegram to NexusForge Server Bridge
const TELEGRAM_TOKEN = "8473410659:AAH2Ww7vSS_vAWwJai2-F-nORQaq_3mQW4";
const RENDER_API_URL = "https://nexus-server-4dbv.onrender.com/api/swarm";

async function startBot() {
    console.log("🤖 Telegram Bridge Started...");
    let offset = 0;

    while (true) {
        try {
            const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
            const data = await response.json();

            if (data.ok && data.result) {
                for (const update of data.result) {
                    offset = update.update_id + 1;
                    
                    if (update.message && update.message.text) {
                        const chatId = update.message.chat.id;
                        const userText = update.message.text;
                        
                        console.log(`📩 Message mila Telegram se: ${userText}`);

                        // Send to Render Server (/api/swarm)
                        const serverRes = await fetch(RENDER_API_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ command: userText })
                        });

                        const serverData = await serverRes.json();
                        const replyText = serverData.managerReply || "AI se koi response nahi aaya.";

                        // Send back reply to Telegram
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: chatId, text: replyText })
                        });
                    }
                }
            }
        } catch (error) {
            console.error("⚠️ Error in Telegram bridge loop:", error);
        }
        // Thoda wait karein taaki API block na ho
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

startBot();
