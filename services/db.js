import pkg from 'pg';
import dotenv from 'dotenv';

// Load environment variables from the .env file
dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 190, // Maximum concurrent clients before new callers queue
  idleTimeoutMillis: 30000, // Release idle clients after 30s
  connectionTimeoutMillis: 2000 // Fail fast if we cannot connect in 2s
});

export default pool;