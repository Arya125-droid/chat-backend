import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import Redis from 'ioredis';
// import OpenAI from 'openai';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.use(cors());
app.use(express.json()); 

// Using PG variables from dotenv
const pool = new pg.Pool({
    // Fallback to connectionString if the explicit variables are missing
    connectionString: process.env.DATABASE_URL 
});

const redis = new Redis(process.env.REDIS_URL);
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

redis.on('error', (err) => {
    console.error('Redis Connection Error:', err.message);
});
redis.on('connect', () => {
    console.log('Connected to Upstash Redis Successfully!');
});

// Redis Rate Limiter 
const checkRateLimit = async (sessionId) => {
    const key = `rate_limit:${sessionId}`;
    const requests = await redis.incr(key);
    
    if (requests === 1) {
        await redis.expire(key, 10); 
    }
    
    if (requests > 5) {
        throw new Error("RATE_LIMIT_EXCEEDED");
    }
};

app.post('/chat/message', async (req, res) => {
    try {
        const { message } = req.body;
        let { sessionId } = req.body;

        // Input Validation (Idiot-proof backend)
        if (!message || message.trim() === "") {
            return res.status(400).json({ error: "Message cannot be empty." });
        }
        if (message.length > 1000) {
            return res.status(400).json({ error: "Message is too long. Max 1000 characters." });
        }

        // Session Management
        if (!sessionId) {
            // Generate a random session ID for new users
            sessionId = crypto.randomBytes(16).toString('hex'); 
        }

        // Redis Rate Limiting Check
        try {
            await checkRateLimit(sessionId);
        } catch (error) {
            return res.status(429).json({ error: "You are sending messages too fast. Please slow down." });
        }

        // Get or Create Conversation Record
        let conversationId;
        const convRes = await pool.query('SELECT id FROM conversations WHERE session_id = $1', [sessionId]);
        
        if (convRes.rows.length > 0) {
            conversationId = convRes.rows[0].id;
        } else {
            const newConv = await pool.query(
                'INSERT INTO conversations (session_id) VALUES ($1) RETURNING id',
                [sessionId]
            );
            conversationId = newConv.rows[0].id;
        }

        // Fetch Seeded Knowledge from Postgres
        const knowledgeRes = await pool.query('SELECT topic, content FROM store_knowledge WHERE is_active = TRUE');
        const knowledgeBase = knowledgeRes.rows.map(row => `${row.topic.toUpperCase()}: ${row.content}`).join('\n');

        // Fetch Conversation History (Redis)
        const redisContextKey = `chat_context:${sessionId}`;
        const rawHistory = await redis.lrange(redisContextKey, 0, -1);
        const history = rawHistory.map(msg => JSON.parse(msg));

        // Generate AI Reply
        const systemPrompt = `You are the official AI customer support agent for Spur, a modern e-commerce brand.
        Your goal is to resolve customer inquiries quickly, accurately, and with a friendly, professional tone.

        CRITICAL RULES:
        1. Be concise. Keep answers under 3 sentences unless detailing a complex policy.
        2. NEVER make up policies, prices, or timelines. ONLY use the STORE KNOWLEDGE provided below.
        3. If a customer asks something not covered in your knowledge base, apologize and state: "I don't have that exact information, but please email support@spur.com and our human team will sort it out!"
        4. You cannot process returns or cancel orders yourself. You can only guide them on the policy.

        STORE KNOWLEDGE:
        ${knowledgeBase}`;

        const llmMessages = [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: message }
        ];

        // ------------------------------------------------------------------------

        // 7. Gemini: Generate AI Reply
        // We use gemini-1.5-flash because it respects your 15 Requests Per Minute limit while staying ultra-fast
        // const generativeModel = await genAI.generateContent({ 
        //     model: "gemini-2.5-flash",
        //     contents: systemPrompt 
        // });

        // Format the Redis history (OpenAI style) to Gemini format
        // 7. Gemini (v2.5) Generation
        
        // Format the Redis history (OpenAI style) to Gemini format
        const formattedHistory = history.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        // Initialize the chat session
        const chat = genAI.chats.create({
            model: "gemini-2.5-flash",
            config: {
                systemInstruction: systemPrompt,
                maxOutputTokens: 150, // Cost and speed control
            },
            history: formattedHistory
        });

        // Send the message (we rely on the outer route's try/catch for error handling)
        const result = await chat.sendMessage({ message: message });
        
        // Extract the clean text and token metrics directly from the new SDK structure
        const aiReply = result.text; 
        const tokensUsed = result.usageMetadata?.totalTokenCount || 0;

        // 8. Persist to PostgreSQL
        await pool.query(
            `INSERT INTO messages (conversation_id, sender, content, tokens_used) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)`,
            [conversationId, 'user', message, 0, 'ai', aiReply, tokensUsed]
        );

        // Update Context Window
        const newUserMsg = JSON.stringify({ role: "user", content: message });
        const newAiMsg = JSON.stringify({ role: "assistant", content: aiReply });
        
        await redis.rpush(redisContextKey, newUserMsg, newAiMsg);
        await redis.ltrim(redisContextKey, -10, -1); // Keep only the last 10 messages in RAM
        await redis.expire(redisContextKey, 60 * 60 * 24); // Expire from RAM after 24 hours

        // Return Payload to Frontend
        return res.status(200).json({
            reply: aiReply,
            sessionId: sessionId
        });

    } catch (error) {
        console.error("API Error:", error);
        return res.status(500).json({ error: "Our AI is currently experiencing high traffic. Please try again in a moment." });
    }
});

const PORT = process.env.PORT || 5001; 
app.listen(PORT, () => {
    console.log(`Spur Chat Backend is running`);
});