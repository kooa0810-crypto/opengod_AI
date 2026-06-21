import readline from 'readline';
import dotenv from 'dotenv';
import pc from 'picocolors';
import { db } from './database.js';
import { skillsManager } from './skills.js';
import { startBot } from './discord.js';
import { runAgent } from './agent.js';
import { performDeepResearch } from './researcher.js';

dotenv.config();

// Ascii Art Banner
const BANNER = `
${pc.blue('===========================================================')}
${pc.bold(pc.cyan('                     OPENGOD AI AGENT                      '))}
${pc.blue('===========================================================')}
${pc.gray(' Inspired by OpenClaude, Hermes Agent, and OpenClaw ')}
`;

async function main() {
  console.log(BANNER);

  // Initialize DB and Skills
  console.log(pc.yellow('[System] Initializing database...'));
  await db.init();

  console.log(pc.yellow('[System] Initializing skills manager...'));
  await skillsManager.init();

  // Start Discord Bot
  const discordStarted = await startBot();

  if (!discordStarted) {
    // Fallback to local interactive terminal REPL
    console.log(pc.green('[System] Starting Local Console Mode...'));
    await startConsoleRepl();
  }
}

/**
 * Local Console Command Line Interface (REPL)
 */
async function startConsoleRepl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise((resolve) => rl.question(query, resolve));

  // Password Authentication Check
  console.log(pc.bold(pc.magenta('\n🔒 ACCESS PROTECTION')));
  const passwordInput = await question('Enter password to unlock OpenGod Agent: ');
  const botPassword = process.env.BOT_PASSWORD || 'opengod';

  if (passwordInput !== botPassword) {
    console.log(pc.red('❌ Access Denied: Incorrect password. Exiting.'));
    rl.close();
    process.exit(1);
  }

  console.log(pc.green('✅ Access Granted. OpenGod console unlocked.'));
  console.log(pc.cyan('Type "/help" to list available console commands.'));

  while (true) {
    const userInput = await question(pc.blue('\nopengod> '));
    const cleanInput = userInput.trim();

    if (!cleanInput) continue;

    if (cleanInput === '/exit' || cleanInput === '/quit') {
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    }

    if (cleanInput === '/help') {
      console.log(pc.bold('\nCommands:'));
      console.log('  /agent <prompt>       - Run OpenClaude reasoning agent loop');
      console.log('  /research <query>     - Run deep web research & synthesize report');
      console.log('  /model [name]         - View or change the active LLM model');
      console.log('  /safesearch <on/off>  - Toggle SafeSearch (currently: ' + (await db.getSetting('safeSearch', true) ? 'ON' : 'OFF') + ')');
      console.log('  /skills               - View learned skills list');
      console.log('  /history              - View research search history');
      console.log('  /exit                 - Close console');
      continue;
    }

    if (cleanInput.startsWith('/safesearch')) {
      const args = cleanInput.split(/\s+/);
      const toggle = args[1]?.toLowerCase();
      if (toggle === 'on') {
        await db.setSetting('safeSearch', true);
        console.log(pc.green('SafeSearch is now ON.'));
      } else if (toggle === 'off') {
        await db.setSetting('safeSearch', false);
        console.log(pc.yellow('SafeSearch is now OFF.'));
      } else {
        const val = await db.getSetting('safeSearch', true);
        console.log(`SafeSearch is currently: ${val ? 'ON' : 'OFF'}`);
      }
      continue;
    }

    if (cleanInput.startsWith('/model')) {
      const args = cleanInput.split(/\s+/);
      const selectedModel = args[1];
      const currentModel = await db.getSetting('model', process.env.OPENROUTER_MODEL || 'nousresearch/hermes-3-llama-3.1-405b');

      if (!selectedModel) {
        console.log(pc.cyan(`\n🤖 Current Model: ${currentModel}`));
        console.log('💡 How to change model: /model <model_name>');
        console.log('\n🌟 Popular OpenRouter Models:');
        console.log('  - nousresearch/hermes-3-llama-3.1-405b');
        console.log('  - meta-llama/llama-3.3-70b-instruct');
        console.log('  - google/gemini-2.5-flash');
        console.log('  - google/gemini-2.5-pro');
        console.log('  - deepseek/deepseek-chat');
      } else {
        await db.setSetting('model', selectedModel);
        console.log(pc.green(`✅ Model successfully changed to: ${selectedModel}`));
      }
      continue;
    }

    if (cleanInput.startsWith('/skills')) {
      const skillsPrompt = skillsManager.getSkillsSystemPrompt();
      console.log(pc.magenta('\nAvailable Learned Skills:'));
      console.log(skillsPrompt);
      continue;
    }

    if (cleanInput.startsWith('/history')) {
      const history = await db.getSearchHistory();
      console.log(pc.magenta('\nSearch History:'));
      if (history.length === 0) {
        console.log('No searches saved yet.');
      } else {
        history.forEach((h, i) => {
          console.log(`${i+1}. [${h.timestamp}] Query: "${h.query}" (${h.results.length} links crawled)`);
        });
      }
      continue;
    }

    if (cleanInput.startsWith('/research')) {
      const query = cleanInput.slice(9).trim();
      if (!query) {
        console.log(pc.red('Please provide a research query. Example: /research Quantum computing'));
        continue;
      }
      console.log(pc.yellow(`🔍 Starting Deep Research on: "${query}"...`));
      try {
        const result = await performDeepResearch(query);
        console.log(pc.magenta('\n╔══════════════════════════════════════════════════════════╗'));
        console.log(pc.magenta('║               🔍 DEEP RESEARCH REPORT                    ║'));
        console.log(pc.magenta('╚══════════════════════════════════════════════════════════╝'));
        console.log(result.report);
      } catch (err) {
        console.error(pc.red(`Research error: ${err.message}`));
      }
      continue;
    }

    if (cleanInput.startsWith('/agent')) {
      const prompt = cleanInput.slice(6).trim();
      if (!prompt) {
        console.log(pc.red('Please provide a prompt. Example: /agent Explain Hermes Agent'));
        continue;
      }
      console.log(pc.yellow('🤖 Starting OpenClaude Agent loop...'));
      try {
        const result = await runAgent(prompt);
        console.log(pc.cyan('\n┌──────────────────────────────────────────────────────────┐'));
        console.log(pc.cyan('│                      🤖 RESPONSE                         │'));
        console.log(pc.cyan('└──────────────────────────────────────────────────────────┘'));
        console.log(result.response);
      } catch (err) {
        console.error(pc.red(`Agent error: ${err.message}`));
      }
      continue;
    }

    // Default: treat as agent query
    console.log(pc.yellow('🤖 Starting OpenClaude Agent loop...'));
    try {
      const result = await runAgent(cleanInput);
      console.log(pc.cyan('\n┌──────────────────────────────────────────────────────────┐'));
      console.log(pc.cyan('│                      🤖 RESPONSE                         │'));
      console.log(pc.cyan('└──────────────────────────────────────────────────────────┘'));
      console.log(result.response);
    } catch (err) {
      console.error(pc.red(`Agent error: ${err.message}`));
    }
  }
}

// Run the script
main().catch(err => {
  console.error(pc.red('Fatal startup error:'), err);
});
