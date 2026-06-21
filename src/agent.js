import { generateChatCompletion } from './openrouter.js';
import { db } from './database.js';
import { skillsManager } from './skills.js';
import { searchWeb, scrapeWebPage, performDeepResearch } from './researcher.js';

const MAX_STEPS = 8;

/**
 * Parses the agent's XML-style output tags.
 */
export function parseAgentResponse(text) {
  const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/i);
  const thought = thoughtMatch ? thoughtMatch[1].trim() : '';

  // Clean the response by stripping thought blocks
  const cleanText = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();

  const callMatch = cleanText.match(/<call\s+name="([^"]+)"\s*>([\s\S]*?)<\/call>/i);
  if (callMatch) {
    const name = callMatch[1].trim();
    const argsRaw = callMatch[2].trim();
    try {
      const args = JSON.parse(argsRaw);
      return { type: 'call', thought, name, args };
    } catch (e) {
      return { type: 'error', thought, error: `Invalid JSON in tool call arguments: ${argsRaw}. Make sure to pass a valid JSON object.` };
    }
  }

  return { type: 'response', thought, text: cleanText };
}

/**
 * Builds the system prompt with active skills and memory keys.
 */
async function buildSystemPrompt() {
  await skillsManager.init();
  const skillsList = skillsManager.getSkillsSystemPrompt();
  
  // Get list of memory keys
  await db.init();
  const memoryKeys = Object.keys(db.data.memory);
  const memoryKeysStr = memoryKeys.length > 0 
    ? memoryKeys.map(k => `- "${k}"`).join('\n') 
    : 'No memories saved yet.';

  return `You are a persistent, autonomous reasoning agent called OpenGod. You operate in a multi-step reasoning loop inspired by OpenClaude, Hermes Agent, and OpenClaw.

You have access to the following tools:
1. web_search: { "query": "string" }
   Finds web pages and snippets related to a search query.
2. read_web_page: { "url": "string" }
   Scrapes and returns cleaned text content from a web page URL.
3. deep_research: { "query": "string" }
   Performs a multi-step deep research process, scraping multiple sites, saving the search history, and compiling a comprehensive markdown report.
4. learn_skill: { "name": "string", "description": "string", "code": "string" }
   Teaches yourself a new skill by writing the body of a Node.js function. The code must be Javascript function body. It receives an object "args".
   Example: "const double = args.val * 2; return double;"
5. run_skill: { "name": "string", "args": {} }
   Executes a previously learned skill by name.
6. save_memory: { "key": "string", "value": any }
   Saves/updates a piece of information to persistent memory.
7. get_memory: { "key": "string" }
   Retrieves a saved memory value by key.

Learned skills currently available to run:
${skillsList}

Persistent memory keys currently stored:
${memoryKeysStr}

CRITICAL RULES:
- You operate in step-by-step turns. In each turn, you MUST write down your thoughts inside <thought>...</thought> tags.
- If you need to call a tool, you must output a <call name="tool_name">JSON_ARGS</call> tag.
- ONLY output ONE tool call per turn. Wait for the system response. Do not output anything after </call> tag.
- If you have resolved the user's request and have the final answer, output your response directly to the user (no <call> tags needed).
- Write clean, concise thoughts explaining your next steps.
`;
}

/**
 * Runs the OpenClaude reasoning agent loop.
 */
export async function runAgent(userPrompt, options = {}) {
  const sessionHistory = [...(options.history || [])];
  
  // Initialize system prompt
  const systemPrompt = await buildSystemPrompt();
  
  // Format message history
  const messages = [
    { role: 'system', content: systemPrompt },
    ...sessionHistory,
    { role: 'user', content: userPrompt }
  ];

  let step = 0;
  let finalResponse = '';
  const agentLog = []; // keep track of thoughts and actions for debugging/discord display

  while (step < MAX_STEPS) {
    step++;
    console.log(`[Agent] Step ${step}/${MAX_STEPS}...`);
    
    try {
      const llmResult = await generateChatCompletion(messages, {
        useLocal: options.useLocal,
        temperature: 0.5
      });

      const rawText = llmResult.text;
      const parsed = parseAgentResponse(rawText);

      // Append assistant's turn to context
      messages.push({ role: 'assistant', content: rawText });

      if (parsed.thought) {
        agentLog.push(`Thought: ${parsed.thought}`);
        console.log(`[Agent] Thought: ${parsed.thought}`);
      }

      if (parsed.type === 'call') {
        const { name, args } = parsed;
        agentLog.push(`Tool Call: ${name}(${JSON.stringify(args)})`);
        console.log(`[Agent] Tool Call: ${name} with args:`, args);

        let result;
        try {
          switch (name) {
            case 'web_search':
              result = await searchWeb(args.query, { safeSearch: options.safeSearch });
              result = JSON.stringify(result, null, 2);
              break;
            case 'read_web_page':
              result = await scrapeWebPage(args.url);
              break;
            case 'deep_research':
              const res = await performDeepResearch(args.query, { safeSearch: options.safeSearch });
              result = `Deep Research report completed successfully.\nReport Preview:\n${res.report.slice(0, 1000)}...\nFull report saved to database.`;
              break;
            case 'learn_skill':
              const learnRes = await skillsManager.learnSkill(args.name, args.description, args.code);
              result = JSON.stringify(learnRes);
              break;
            case 'run_skill':
              const runRes = await skillsManager.executeSkill(args.name, args.args);
              result = typeof runRes === 'object' ? JSON.stringify(runRes) : String(runRes);
              break;
            case 'save_memory':
              const saveRes = await db.saveMemory(args.key, args.value);
              result = `Memory saved: ${args.key} = ${JSON.stringify(saveRes)}`;
              break;
            case 'get_memory':
              const getRes = await db.getMemory(args.key);
              result = getRes !== null ? `Memory value: ${JSON.stringify(getRes)}` : `No memory found for key: "${args.key}"`;
              break;
            default:
              result = `Error: Unknown tool "${name}". Available tools: web_search, read_web_page, deep_research, learn_skill, run_skill, save_memory, get_memory.`;
          }
        } catch (toolErr) {
          result = `Error executing tool "${name}": ${toolErr.message}`;
        }

        console.log(`[Agent] Tool Result (truncated): ${result.slice(0, 200)}...`);
        messages.push({ role: 'user', content: `<response>\n${result}\n</response>` });
      } 
      else if (parsed.type === 'error') {
        agentLog.push(`Error: ${parsed.error}`);
        console.error(`[Agent] Parser Error: ${parsed.error}`);
        messages.push({ role: 'user', content: `<response>\nError: ${parsed.error}\n</response>` });
      } 
      else {
        // Final response
        finalResponse = parsed.text;
        break;
      }
    } catch (err) {
      console.error('[Agent] Execution error inside loop:', err);
      finalResponse = `An error occurred during agent execution: ${err.message}`;
      break;
    }
  }

  if (step >= MAX_STEPS && !finalResponse) {
    finalResponse = 'Agent reached maximum reasoning steps before outputting a final answer. Please try refining your query.';
  }

  return {
    response: finalResponse,
    log: agentLog,
    steps: step
  };
}
