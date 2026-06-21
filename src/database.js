import { promises as fs } from 'fs';
import path from 'path';

const DB_DIR = path.resolve('./data');
const DB_FILE = path.join(DB_DIR, 'db.json');

// Default database structure
const DEFAULT_DB = {
  authenticatedUsers: [], // Array of Discord User IDs
  searchHistory: [],      // Array of { timestamp, query, keywords, results, report }
  settings: {
    safeSearch: true,     // Default safe search state
  },
  memory: {}              // key-value memory for the agent
};

class Database {
  constructor() {
    this.data = { ...DEFAULT_DB };
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    try {
      // Ensure the data directory exists
      await fs.mkdir(DB_DIR, { recursive: true });

      // Check if db.json exists, if not create it
      try {
        const fileContent = await fs.readFile(DB_FILE, 'utf-8');
        this.data = JSON.parse(fileContent);
        // Merge with defaults to ensure all keys exist
        this.data = { ...DEFAULT_DB, ...this.data };
      } catch (err) {
        if (err.code === 'ENOENT') {
          await this.save();
        } else {
          console.error('Error reading database file, resetting to default:', err);
          await this.save();
        }
      }

      this.initialized = true;
      console.log('Database initialized successfully.');
    } catch (error) {
      console.error('Failed to initialize database:', error);
      throw error;
    }
  }

  async save() {
    try {
      await fs.writeFile(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save database:', error);
    }
  }

  // Authentication Helpers
  async authenticateUser(userId) {
    await this.init();
    if (!this.data.authenticatedUsers.includes(userId)) {
      this.data.authenticatedUsers.push(userId);
      await this.save();
    }
    return true;
  }

  async isUserAuthenticated(userId) {
    await this.init();
    return this.data.authenticatedUsers.includes(userId);
  }

  async deauthenticateUser(userId) {
    await this.init();
    this.data.authenticatedUsers = this.data.authenticatedUsers.filter(id => id !== userId);
    await this.save();
    return true;
  }

  // Search History Helpers
  async saveSearch(query, keywords, results, report) {
    await this.init();
    const searchEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      query,
      keywords,
      results: results.map(r => ({ title: r.title, url: r.url })),
      report
    };
    this.data.searchHistory.push(searchEntry);
    // Keep last 100 search logs to prevent database from bloating too much
    if (this.data.searchHistory.length > 100) {
      this.data.searchHistory.shift();
    }
    await this.save();
    return searchEntry;
  }

  async getSearchHistory() {
    await this.init();
    return this.data.searchHistory;
  }

  // Settings Helpers
  async getSetting(key, defaultValue) {
    await this.init();
    return this.data.settings[key] !== undefined ? this.data.settings[key] : defaultValue;
  }

  async setSetting(key, value) {
    await this.init();
    this.data.settings[key] = value;
    await this.save();
    return value;
  }

  // Memory Helpers
  async getMemory(key, defaultValue = null) {
    await this.init();
    return this.data.memory[key] !== undefined ? this.data.memory[key] : defaultValue;
  }

  async saveMemory(key, value) {
    await this.init();
    this.data.memory[key] = value;
    await this.save();
    return value;
  }
}

export const db = new Database();
export default db;
