require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { EMA, RSI, MACD, ATR } = require('technicalindicators');
const Snoowrap = require('snoowrap');
const Sentiment = require('sentiment');

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || '';
const REDDIT_USER = process.env.REDDIT_USER || '';
const REDDIT_PASS = process.env.REDDIT_PASS || '';
const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3';

// Log and validate CHAT_ID
console.log(`Raw CHAT_ID: "${CHAT_ID}" (length: ${CHAT_ID.length}, bytes: ${Buffer.from(CHAT_ID).toString('hex')})`);
if (!CHAT_ID || (!CHAT_ID.startsWith('-') && !/^\d+$/.test(CHAT_ID))) {
  console.error('Invalid CHAT_ID: Must be a negative number (group) or positive number (user)');
  process.exit(1);
}

// Initialize clients
let bot;
try {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
} catch (error) {
  console.error('Failed to initialize Telegram bot:', error.message);
  process.exit(1);
}

const reddit = new Snoowrap({
  userAgent: 'crypto-bot',
  clientId: REDDIT_CLIENT_ID,
  clientSecret: REDDIT_CLIENT_SECRET,
  username: REDDIT_USER,
  password: REDDIT_PASS
});
const sentimentAnalyzer = new Sentiment();

// List of symbols to scan
const symbols = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT',
  'DOGE/USDT', 'BNB/USDT', 'LTC/USDT', 'LINK/USDT', 'MATIC/USDT'
];

// Map symbol to CoinGecko coin ID
const symbolToCoinId = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'SOL': 'solana',
  'XRP': 'ripple',
  'ADA': 'cardano',
  'DOGE': 'dogecoin',
  'BNB': 'binancecoin',
  'LTC': 'litecoin',
  'LINK': 'chainlink',
  'MATIC': 'matic-network'
};

// Cache CoinGecko coin list
let coinList = null;
async function getCoinId(symbol) {
  const coinId = symbolToCoinId[symbol.split('/')[0]] || symbol.split('/')[0].toLowerCase();
  if (coinList === null) {
    try {
      console.log('Fetching CoinGecko coin list...');
      const response = await axios.get(`${COINGECKO_API_URL}/coins/list`, { timeout: 10000 });
      coinList = response.data;
    } catch (error) {
      console.error('Error fetching CoinGecko coin list:', error.message);
      return 'bitcoin';
    }
  }
  const coin = coinList.find(c => c.id === coinId || c.symbol.toUpperCase() === symbol.split('/')[0]);
  return coin ? coin.id : 'bitcoin';
}

// Retry function
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1 || error.response?.status !== 429) throw error;
      console.log(`Retrying API call (${i + 1}/${retries}) after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Fetch market data from CoinGecko
async function fetchMarketData(symbol, timeframe = '1h', limit = 100) {
  try {
    const coinId = await getCoinId(symbol);
    const days = '1';
    const url = `${COINGECKO_API_URL}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
    console.log(`Fetching CoinGecko data: ${url}`);
    const response = await withRetry(() =>
      axios.get(url, { timeout: 10000 })
    );
    if (!response.data || response.data.length === 0) {
      throw new Error('No OHLCV data returned');
    }
    const ohlcv = response.data.slice(-limit);
    if (ohlcv.length < limit) {
      console.warn(`Received ${ohlcv.length} candles, requested ${limit}`);
    }
    return ohlcv.map(candle => ({
      timestamp: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: 0
    }));
  } catch (error) {
    console.error(`Error fetching market data for ${symbol}:`, error.message, error.response?.data || '');
    return null;
  }
}

// Analyze trend for futures signals
async function analyzeTrend(symbol, data) {
  if (!data || data.length < 26) {
    console.log(`Insufficient data for ${symbol}:`, data?.length || 0);
    return { symbol, longScore: 0, shortScore: 0, stopLoss: null, takeProfit: null, atr: 0 };
  }

  const closes = data.map(candle => candle.close);
  const highs = data.map(candle => candle.high);
  const lows = data.map(candle => candle.low);
  const currentPrice = closes[closes.length - 1];

  // EMA
  const emaFast = EMA.calculate({ period: 12, values: closes });
  const emaSlow = EMA.calculate({ period: 26, values: closes });
  const lastEmaFast = emaFast[emaFast.length - 1];
  const lastEmaSlow = emaSlow[emaSlow.length - 1];

  // RSI
  const rsi = RSI.calculate({ period: 14, values: closes });
  const lastRsi = rsi[rsi.length - 1];

  // MACD
  const macd = MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes });
  const lastMacd = macd[macd.length - 1];
  const macdLine = lastMacd.MACD;
  const signalLine = lastMacd.signal;

  // ATR
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const lastAtr = atr[atr.length - 1];

  // Sentiment
  const cryptoName = symbolToCoinId[symbol.split('/')[0]] || symbol.split('/')[0].toLowerCase();
  const sentiment = await analyzeSentiment(cryptoName);

  // Scoring
  let longScore = 0;
  let shortScore = 0;

  // EMA: 0.3 points
  if (lastEmaFast > lastEmaSlow) longScore += 0.3;
  else if (lastEmaFast < lastEmaSlow) shortScore += 0.3;

  // RSI: 0.2 points
  if (lastRsi < 70) longScore += 0.2;
  if (lastRsi > 30) shortScore += 0.2;

  // MACD: 0.3 points
  if (macdLine > signalLine) longScore += 0.3;
  else if (macdLine < signalLine) shortScore += 0.3;

  // Sentiment: 0.2 points
  if (sentiment === 'POSITIVE') longScore += 0.2;
  else if (sentiment === 'NEGATIVE') shortScore += 0.2;

  // ATR adjustment (lower ATR = less risk)
  const atrMultiplier = 1 / (1 + lastAtr / currentPrice); // Normalize ATR
  longScore *= atrMultiplier;
  shortScore *= atrMultiplier;

  // Stop-loss and take-profit
  const stopLoss = longScore > shortScore
    ? currentPrice - lastAtr * 1.5
    : currentPrice + lastAtr * 1.5;
  const takeProfit = longScore > shortScore
    ? currentPrice + lastAtr * 3
    : currentPrice - lastAtr * 3;

  return { symbol, longScore, shortScore, stopLoss, takeProfit, atr: lastAtr };
}

// Analyze sentiment from Reddit
async function analyzeSentiment(crypto) {
  try {
    console.log(`Fetching Reddit posts for ${crypto}`);
    const posts = await reddit.getSubreddit('cryptocurrency').search({ query: crypto, limit: 50 });
    let totalSentiment = 0;
    let count = 0;

    for (const post of posts) {
      const analysis = sentimentAnalyzer.analyze(post.title);
      totalSentiment += analysis.comparative;
      count++;
    }

    const avgSentiment = count > 0 ? totalSentiment / count : 0;
    console.log(`Sentiment for ${crypto}: ${avgSentiment}`);
    if (avgSentiment > 0.05) return 'POSITIVE';
    if (avgSentiment < -0.05) return 'NEGATIVE';
    return 'NEUTRAL';
  } catch (error) {
    console.error(`Error analyzing sentiment for ${crypto}:`, error.message);
    return 'NEUTRAL';
  }
}

// Send message to Telegram group
async function sendMessage(message) {
  try {
    await bot.sendMessage(CHAT_ID, message);
    console.log(`Message sent to Telegram (CHAT_ID: ${CHAT_ID}):`, message);
  } catch (error) {
    console.error(`Error sending Telegram message to CHAT_ID ${CHAT_ID}:`, error.message);
    throw error;
  }
}

// Handle /analyze command
bot.onText(/\/analyze(?:\s+(.+))?/, async (msg, match) => {
  const symbol = match[1] ? `${match[1].toUpperCase()}/USDT` : 'BTC/USDT';
  console.log(`Processing /analyze for ${symbol}`);

  const marketData = await fetchMarketData(symbol);
  const { longScore, shortScore, stopLoss, takeProfit } = await analyzeTrend(symbol, marketData);
  const sentiment = await analyzeSentiment(symbolToCoinId[symbol.split('/')[0]] || symbol.split('/')[0].toLowerCase());

  const signal = longScore > shortScore ? 'LONG' : shortScore > longScore ? 'SHORT' : 'NEUTRAL';
  let message = `Futures Analysis for ${symbol}:\n` +
                `Signal: ${signal}\n` +
                `Confidence: ${(Math.max(longScore, shortScore) * 100).toFixed(1)}%\n` +
                `Sentiment: ${sentiment}\n` +
                `Stop-Loss: ${stopLoss ? stopLoss.toFixed(2) : 'N/A'}\n` +
                `Take-Profit: ${takeProfit ? takeProfit.toFixed(2) : 'N/A'}`;
  if (signal === 'LONG' && sentiment === 'POSITIVE') {
    message += '\nRecommendation: Strong Buy (Futures Long)';
  } else if (signal === 'SHORT' && sentiment === 'NEGATIVE') {
    message += '\nRecommendation: Strong Sell (Futures Short)';
  } else {
    message += '\nRecommendation: Hold';
  }

  try {
    await sendMessage(message);
    await bot.sendMessage(msg.chat.id, 'Futures analysis sent to group!');
  } catch (error) {
    await bot.sendMessage(msg.chat.id, `Error sending analysis. Verify CHAT_ID (${CHAT_ID}) and bot permissions.`);
  }
});

// Handle /bestopportunity command
bot.onText(/\/bestopportunity/, async (msg) => {
  console.log('Processing /bestopportunity');
  const opportunities = [];

  for (const symbol of symbols) {
    const marketData = await fetchMarketData(symbol);
    if (marketData) {
      const result = await analyzeTrend(symbol, marketData);
      opportunities.push(result);
    }
  }

  if (opportunities.length === 0) {
    const errorMsg = 'No opportunities found due to data issues.';
    await bot.sendMessage(msg.chat.id, errorMsg);
    return;
  }

  // Find best opportunity
  const best = opportunities.reduce((prev, curr) => {
    const prevScore = Math.max(prev.longScore, prev.shortScore);
    const currScore = Math.max(curr.longScore, curr.shortScore);
    return currScore > prevScore ? curr : prev;
  });

  const signal = best.longScore > best.shortScore ? 'LONG' : 'SHORT';
  const confidence = Math.max(best.longScore, best.shortScore) * 100;
  const sentiment = await analyzeSentiment(symbolToCoinId[best.symbol.split('/')[0]] || best.symbol.split('/')[0].toLowerCase());

  let message = `Best Futures Opportunity:\n` +
                `Symbol: ${best.symbol}\n` +
                `Signal: ${signal}\n` +
                `Confidence: ${confidence.toFixed(1)}%\n` +
                `Sentiment: ${sentiment}\n` +
                `Stop-Loss: ${best.stopLoss ? best.stopLoss.toFixed(2) : 'N/A'}\n` +
                `Take-Profit: ${best.takeProfit ? best.takeProfit.toFixed(2) : 'N/A'}`;
  if (signal === 'LONG' && sentiment === 'POSITIVE') {
    message += '\nRecommendation: Strong Buy (Futures Long)';
  } else if (signal === 'SHORT' && sentiment === 'NEGATIVE') {
    message += '\nRecommendation: Strong Sell (Futures Short)';
  } else {
    message += '\nRecommendation: Consider Carefully';
  }

  try {
    await sendMessage(message);
    await bot.sendMessage(msg.chat.id, 'Best opportunity sent to group! Add -100 if it works! 😄');
  } catch (error) {
    await bot.sendMessage(msg.chat.id, `Error sending opportunity. Verify CHAT_ID (${CHAT_ID}) and bot permissions.`);
  }
});

// Handle /testchat command
bot.onText(/\/testchat/, async (msg) => {
  try {
    await bot.sendMessage(CHAT_ID, 'Test message from bot');
    await bot.sendMessage(msg.chat.id, `Test message sent to CHAT_ID ${CHAT_ID}`);
  } catch (error) {
    console.error(`Testchat failed for CHAT_ID ${CHAT_ID}:`, error.message);
    await bot.sendMessage(msg.chat.id, `Failed to send test message to CHAT_ID ${CHAT_ID}: ${error.message}`);
  }
});

// Handle polling errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

// Log bot startup
console.log('Bot is running...');