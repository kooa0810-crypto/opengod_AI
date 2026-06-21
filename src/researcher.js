import * as cheerio from 'cheerio';
import { generateChatCompletion } from './openrouter.js';
import { db } from './database.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Searches DuckDuckGo (HTML version) and returns results.
 * Respects the SafeSearch toggle (kp parameter: 1 = Strict, -2 = Off).
 */
export async function searchWeb(query, options = {}) {
  const safeSearch = options.safeSearch ?? (await db.getSetting('safeSearch', true));
  const kp = safeSearch ? '1' : '-2';
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=${kp}`;

  console.log(`[Research] Searching DuckDuckGo for: "${query}" (SafeSearch: ${safeSearch ? 'ON' : 'OFF'})`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo search request failed: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.result').each((_, element) => {
      const titleEl = $(element).find('.result__a');
      const snippetEl = $(element).find('.result__snippet');

      if (titleEl.length > 0) {
        const title = titleEl.text().trim();
        let href = titleEl.attr('href') || '';

        // Decode DDG redirect URL (e.g. //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com)
        if (href.includes('uddg=')) {
          try {
            const fullUrl = href.startsWith('http') ? href : `https:${href}`;
            const parsedUrl = new URL(fullUrl);
            const uddg = parsedUrl.searchParams.get('uddg');
            if (uddg) href = decodeURIComponent(uddg);
          } catch (e) {
            // fallback if URL parsing fails
          }
        }

        const snippet = snippetEl.text().trim();
        if (title && href) {
          results.push({ title, url: href, snippet });
        }
      }
    });

    return results.slice(0, 8); // return top 8 results
  } catch (error) {
    console.error('[Research] DuckDuckGo search error:', error);
    return [];
  }
}

/**
 * Fetches a web page and extracts clean text content.
 */
export async function scrapeWebPage(url) {
  console.log(`[Research] Scraping page: ${url}`);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch page: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove unwanted elements
    $('script, style, noscript, iframe, header, footer, nav, svg').remove();

    // Extract text from main content tags if available, else fallback to body
    const mainContentSelectors = ['main', 'article', '#content', '.content', 'body'];
    let extractedText = '';

    for (const selector of mainContentSelectors) {
      const el = $(selector);
      if (el.length > 0) {
        // Simple text consolidation with paragraph preservation
        el.find('p, h1, h2, h3, h4, h5, li').each((_, child) => {
          extractedText += $(child).text().trim() + '\n\n';
        });
        break;
      }
    }

    if (!extractedText) {
      extractedText = $('body').text();
    }

    // Clean up excessive whitespace
    const cleanText = extractedText
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();

    return cleanText.slice(0, 10000); // limit to 10k chars (approx 2k-2.5k tokens)
  } catch (error) {
    console.error(`[Research] Scrape page error for ${url}:`, error.message);
    return '';
  }
}

/**
 * Deep Research Orchestrator.
 * 1. LLM plans search queries.
 * 2. Scrapes results.
 * 3. Fetches contents.
 * 4. Synthesizes report.
 */
export async function performDeepResearch(userQuery, options = {}) {
  const safeSearch = options.safeSearch ?? (await db.getSetting('safeSearch', true));
  
  // Step 1: Formulate search queries
  const planPrompt = [
    {
      role: 'system',
      content: 'You are an advanced researcher. Based on the user\'s research topic, output a JSON array containing 2 to 3 distinct search queries that would yield the most comprehensive information on this topic. Output ONLY a valid JSON array of strings, nothing else.'
    },
    {
      role: 'user',
      content: `Research Topic: "${userQuery}"`
    }
  ];

  let queries = [userQuery];
  try {
    const planResponse = await generateChatCompletion(planPrompt, {
      responseFormat: { type: 'json_object' }
    });
    
    // Parse response
    const parsed = JSON.parse(planResponse.text);
    if (Array.isArray(parsed)) {
      queries = parsed;
    } else if (parsed.queries && Array.isArray(parsed.queries)) {
      queries = parsed.queries;
    }
  } catch (err) {
    console.warn('[Research] Failed to generate query list, falling back to original query:', err.message);
  }

  console.log(`[Research] Formulated queries:`, queries);

  // Step 2: Run searches and compile links
  const allLinks = new Map(); // url -> {title, snippet}
  
  for (const query of queries) {
    const searchResults = await searchWeb(query, { safeSearch });
    for (const result of searchResults) {
      if (!allLinks.has(result.url)) {
        allLinks.set(result.url, { title: result.title, snippet: result.snippet });
      }
    }
  }

  const uniqueLinks = Array.from(allLinks.entries()).map(([url, info]) => ({ url, ...info }));
  console.log(`[Research] Discovered ${uniqueLinks.length} unique URLs.`);

  // Step 3: Fetch top pages (limit to top 4 to keep context clean and speed up)
  const pagesToScrape = uniqueLinks.slice(0, 4);
  const scrapedPages = [];

  for (const page of pagesToScrape) {
    const pageText = await scrapeWebPage(page.url);
    if (pageText.length > 200) { // must contain substantial text
      scrapedPages.push({
        url: page.url,
        title: page.title,
        content: pageText
      });
    }
  }

  // Step 4: Synthesize Report
  console.log(`[Research] Synthesizing final report with ${scrapedPages.length} scraped sources...`);
  
  const sourcesContext = scrapedPages.map((page, idx) => {
    return `--- Source [${idx + 1}]: ${page.title} (${page.url}) ---\n${page.content}\n`;
  }).join('\n');

  const synthesisPrompt = [
    {
      role: 'system',
      content: 'You are an elite research assistant. Synthesize the provided search results and scraped webpage contents into a highly structured, comprehensive, and objective research report. Use markdown headers, tables, lists, and bullet points. Properly cite your sources using inline numbering (e.g. [1]) referring to the sources at the bottom.'
    },
    {
      role: 'user',
      content: `Research Question: "${userQuery}"\n\n${sourcesContext}\n\nProvide the complete research report.`
    }
  ];

  const synthesisResponse = await generateChatCompletion(synthesisPrompt, {
    temperature: 0.3 // low temperature for research accuracy
  });

  const finalReport = synthesisResponse.text;

  // Step 5: Save Search to Database
  await db.saveSearch(userQuery, uniqueLinks, finalReport);

  return {
    query: userQuery,
    queries,
    links: uniqueLinks,
    report: finalReport
  };
}
