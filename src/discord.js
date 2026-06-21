import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from 'discord.js';
import dotenv from 'dotenv';
import { db } from './database.js';
import { runAgent } from './agent.js';
import { performDeepResearch } from './researcher.js';
import { getBase64DataUrl } from './openrouter.js';
import pc from 'picocolors';

dotenv.config();

const PREFIX = '!';

// Initialize Discord Client with appropriate intents and partials (DMs require partials)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [
    Partials.Channel,
    Partials.Message
  ]
});

/**
 * Splits or uploads content as file if it exceeds Discord's 2000-character limit.
 */
async function replyWithSafeContent(message, text, filename = 'output.md') {
  if (text.length <= 1950) {
    return await message.reply(text);
  } else {
    const attachment = new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: filename });
    return await message.reply({
      content: '⚠️ The content exceeds Discord\'s 2000-character limit. Here is the full output as a document:',
      files: [attachment]
    });
  }
}

client.once('ready', () => {
  console.log(pc.green(`[Discord] Bot is logged in as ${client.user.tag}`));
  console.log(pc.cyan(`[Discord] Prefix is "${PREFIX}". Server is listening for commands...`));
});

client.on('messageCreate', async (message) => {
  // Ignore bots
  if (message.author.bot) return;

  // Check prefix
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const userId = message.author.id;

  try {
    // 1. HELP COMMAND (Always open)
    if (command === 'help') {
      const helpText = `**🤖 OpenGod AI Agent Commands**
  
\`${PREFIX}auth <password>\` - Authenticate your session (Recommended to run in DM).
\`${PREFIX}deauth\` - Revoke your current session.
\`${PREFIX}agent <prompt>\` - Run the OpenClaude reasoning agent loop (Supports image attachments).
\`${PREFIX}research <query>\` - Run deep web research & generate a structured report.
\`${PREFIX}model [name]\` - View or change the active LLM model.
\`${PREFIX}safesearch <on/off>\` - Toggle SafeSearch filter for search results.
\`${PREFIX}skills\` - List all dynamically learned skills.
\`${PREFIX}history\` - View previous deep research queries.

*Tip: For password privacy, send me \`${PREFIX}auth <password>\` in a direct message!*`;
      return await message.reply(helpText);
    }

    // 2. AUTHENTICATE COMMAND (Always open)
    if (command === 'auth') {
      const inputPass = args[0];
      const botPass = process.env.BOT_PASSWORD || 'opengod';

      if (!inputPass) {
        return await message.reply(`❌ Please provide a password. Format: \`${PREFIX}auth <password>\``);
      }

      if (inputPass === botPass) {
        await db.authenticateUser(userId);
        
        // Delete message if in public guild channel to protect password
        if (message.guild) {
          try {
            await message.delete();
          } catch (e) {
            console.warn('[Discord] Could not delete public password message:', e.message);
          }
        }
        
        return await message.reply('✅ **Authentication Successful!** You now have full access to the AI agent commands.');
      } else {
        return await message.reply('❌ **Incorrect Password.** Access denied.');
      }
    }

    // --- ALL COMMANDS BELOW REQUIRE AUTHENTICATION ---
    const isAuthenticated = await db.isUserAuthenticated(userId);
    if (!isAuthenticated) {
      return await message.reply(`❌ **Access Denied.** You must authenticate first.\nRun \`${PREFIX}auth <password>\` (preferably in a Direct Message to keep it private).`);
    }

    // 3. DE-AUTHENTICATE COMMAND
    if (command === 'deauth') {
      await db.deauthenticateUser(userId);
      return await message.reply('✅ Your session has been successfully revoked.');
    }

    // 4. SAFESEARCH CONFIG
    if (command === 'safesearch') {
      const toggle = args[0]?.toLowerCase();
      if (toggle === 'on' || toggle === 'true') {
        await db.setSetting('safeSearch', true);
        return await message.reply('🛡️ SafeSearch is now **ON**.');
      } else if (toggle === 'off' || toggle === 'false') {
        await db.setSetting('safeSearch', false);
        return await message.reply('🔓 SafeSearch is now **OFF**.');
      } else {
        const current = await db.getSetting('safeSearch', true);
        return await message.reply(`SafeSearch is currently **${current ? 'ON' : 'OFF'}**. Use \`${PREFIX}safesearch on\` or \`${PREFIX}safesearch off\` to change it.`);
      }
    }

    // 5. AGENT COMMAND (With thoughts reasoning loop and optional Vision input)
    if (command === 'agent') {
      const prompt = args.join(' ');
      if (!prompt) {
        return await message.reply(`❌ Please enter a prompt for the agent. Format: \`${PREFIX}agent <your prompt>\``);
      }

      // Check for image attachments
      const imageAttachment = message.attachments.find(a => 
        a.contentType?.startsWith('image/')
      );

      const statusMsg = await message.reply('🤖 *Thinking... (OpenClaude Agent is starting)*');

      try {
        const promptContent = [];
        promptContent.push({ type: 'text', text: prompt });

        if (imageAttachment) {
          await statusMsg.edit('🤖 *Downloading image and starting OpenClaude Agent...*');
          const base64Url = await getBase64DataUrl(imageAttachment.url);
          promptContent.push({
            type: 'image_url',
            image_url: { url: base64Url }
          });
        }

        const agentMessages = [
          { role: 'user', content: promptContent }
        ];

        // Retrieve SafeSearch state
        const safeSearch = await db.getSetting('safeSearch', true);
        const useLocal = process.env.USE_LOCAL_LLM === 'true';

        const result = await runAgent(prompt, {
          history: [],
          safeSearch,
          useLocal
        });

        // Format final response
        let responsePayload = `**Answer:**\n${result.response}`;

        await statusMsg.delete();
        await replyWithSafeContent(message, responsePayload, 'agent_response.md');
      } catch (err) {
        await statusMsg.edit(`❌ Error running agent: ${err.message}`);
      }
    }

    // 6. DEEP RESEARCH COMMAND
    if (command === 'research') {
      const query = args.join(' ');
      if (!query) {
        return await message.reply(`❌ Please enter a query. Format: \`${PREFIX}research <topic>\``);
      }

      const statusMsg = await message.reply(`🔍 *Starting Deep Research on "${query}"... (Formulating queries and searching web)*`);

      try {
        const safeSearch = await db.getSetting('safeSearch', true);
        const researchResult = await performDeepResearch(query, { safeSearch });

        await statusMsg.delete();

        const responseText = `## 🔍 Deep Research Report: "${query}"\n\n${researchResult.report}`;
        await replyWithSafeContent(message, responseText, 'research_report.md');
      } catch (err) {
        await statusMsg.edit(`❌ Deep Research failed: ${err.message}`);
      }
    }

    // 7. HISTORY COMMAND
    if (command === 'history') {
      const history = await db.getSearchHistory();
      if (history.length === 0) {
        return await message.reply('No search history found.');
      }

      const list = history.map((item, index) => {
        return `${index + 1}. **${item.query}** (${new Date(item.timestamp).toLocaleString()}) - *${item.results.length} URLs crawled*`;
      }).join('\n');

      return await message.reply(`📜 **Saved Research History:**\n${list}`);
    }

    // 8. SKILLS COMMAND
    if (command === 'skills') {
      const list = await db.getSetting('skills', []); // fallback or query skills manager
      const systemPrompt = skillsManager.getSkillsSystemPrompt();
      return await message.reply(`🛠️ **Learned Skills:**\n${systemPrompt}`);
    }

    // 9. MODEL SELECTION COMMAND
    if (command === 'model') {
      const selectedModel = args[0];
      const currentModel = await db.getSetting('model', process.env.OPENROUTER_MODEL || 'nousresearch/hermes-3-llama-3.1-405b');

      if (!selectedModel) {
        return await message.reply(`🤖 **Current Model:** \`${currentModel}\`

💡 **How to change model:**
\`${PREFIX}model <model_name>\`

🌟 **Popular OpenRouter Models:**
- \`nousresearch/hermes-3-llama-3.1-405b\`
- \`meta-llama/llama-3.3-70b-instruct\`
- \`google/gemini-2.5-flash\`
- \`google/gemini-2.5-pro\`
- \`deepseek/deepseek-chat\``);
      }

      await db.setSetting('model', selectedModel);
      return await message.reply(`✅ Model successfully changed to: \`${selectedModel}\``);
    }

  } catch (error) {
    console.error(`[Discord] Error executing command "${command}":`, error);
    await message.reply(`❌ An unexpected error occurred: ${error.message}`);
  }
});

/**
 * Starts the Discord Bot.
 */
export async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.log(pc.yellow('\n⚠️ DISCORD_TOKEN is missing in .env!'));
    console.log(pc.yellow('The bot will run in Local Console Mode instead. Set DISCORD_TOKEN to run the Discord Bot.\n'));
    return false;
  }
  
  await client.login(token);
  return true;
}

export default startBot;
