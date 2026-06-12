import {Pool} from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const pool = new Pool({
//     user: process.env.PG_USER,
//     host: process.env.PG_HOST,
//     database: process.env.PG_DATABASE,
//   //   password: process.env.PG_PASSWORD || 'password', // change to your local password
//     port: process.env.PG_PORT,
    connectionString: process.env.DATABASE_URL 
});
  
const initialiseDatabase = async()=>{
    console.log("Connecting to PostgreSQL...");

    const createTablesQuery = `
        CREATE TABLE IF NOT EXISTS conversations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id VARCHAR(255) UNIQUE NOT NULL,
            status VARCHAR(50) DEFAULT 'active',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
            sender VARCHAR(50) NOT NULL CHECK (sender IN ('user', 'ai')),
            content TEXT NOT NULL,
            tokens_used INT DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS store_knowledge (
            id SERIAL PRIMARY KEY,
            topic VARCHAR(100) NOT NULL,
            content TEXT NOT NULL,
            is_active BOOLEAN DEFAULT TRUE
        );
    `;

    const seedKnowledgeQuery = `
        INSERT INTO store_knowledge (topic, content)
        VALUES 
            ('shipping', 'We offer free standard shipping on orders over $50. Deliveries take 3-5 business days.'),
            ('returns', 'You can return any unworn item within 30 days for a full refund.')
        ON CONFLICT DO NOTHING;
    `;

    try {
        await pool.query(createTablesQuery);
        console.log("Database Tables Created Successfully!");
        
        await pool.query(seedKnowledgeQuery);
        console.log("Store Knowledge Seeded!");
    } catch (error) {
        console.error("Database Initialization Failed:", error);
    } finally {
        await pool.end();
    }
}

initialiseDatabase();