  // FRVP Volume Profile Telegram Bot
  // Установка: npm install node-telegram-bot-api node-fetch node-cron dotenv

  require('dotenv').config();
  const TelegramBot = require('node-telegram-bot-api');
  const fetch = require('node-fetch');
  const cron = require('node-cron');
  const fs = require('fs');
  const path = require('path');

  // ============================================================================
  // ЗАГРУЗКА КОНФИГУРАЦИИ
  // ============================================================================

  let config;
  try {
    const configPath = path.join(__dirname, 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('✅ Конфигурация загружена из config.json');
  } catch (error) {
    console.error('❌ Ошибка загрузки config.json:', error.message);
    console.error('Создайте файл config.json или используйте config.json.example');
    process.exit(1);
  }

  // ============================================================================
  // КОНФИГУРАЦИЯ
  // ============================================================================

  const CONFIG = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    CHAT_ID: process.env.CHAT_ID,
    
    // Параметры по умолчанию
    SYMBOL: process.env.SYMBOL || config.symbols[0].symbol,
    INTERVAL: process.env.INTERVAL || '1h',
    BARS_COUNT: parseInt(process.env.BARS_COUNT) || 150,
    ROW_SIZE: parseInt(process.env.ROW_SIZE) || config.settings.rowSize,
    VALUE_AREA: parseFloat(process.env.VALUE_AREA) || config.settings.valueAreaPercent,
    
    // Частота обновления
    UPDATE_FREQUENCY: process.env.UPDATE_FREQUENCY || 'hourly'
  };

  // Проверка токена
  if (!CONFIG.TELEGRAM_TOKEN || CONFIG.TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN') {
    console.error('❌ ОШИБКА: Токен Telegram не установлен!');
    console.error('');
    console.error('Как получить токен:');
    console.error('1. Найдите @BotFather в Telegram');
    console.error('2. Отправьте /newbot');
    console.error('3. Следуйте инструкциям');
    console.error('4. Скопируйте токен в файл .env:');
    console.error('   TELEGRAM_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz');
    console.error('');
    process.exit(1);
  }

  // Пользовательские настройки (для каждого чата)
  const userSettings = new Map();

  // История цен для отслеживания пересечений уровней
  const priceHistory = new Map();

  // ============================================================================
  // ИНИЦИАЛИЗАЦИЯ БОТА
  // ============================================================================

  const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { 
    polling: {
      interval: 300,
      autoStart: true,
      params: {
        timeout: 10
      }
    }
  });

  console.log('🤖 FRVP Telegram Bot запущен...');
  console.log('📊 Ожидание подключения к Telegram...');

  // ============================================================================
  // ПОЛУЧЕНИЕ ДАННЫХ С BINANCE
  // ============================================================================

  async function getBinanceKlines(symbol, interval, limit) {
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Binance API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      return data.map(candle => ({
        time: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5])
      }));
    } catch (error) {
      console.error('Ошибка получения данных Binance:', error);
      throw error;
    }
  }

  // ============================================================================
  // РАСЧЁТ FRVP (КАК В PINE SCRIPT)
  // ============================================================================

  function getVol(y11, y12, y21, y22, height, vol) {
    if (height === 0) return 0;
    const intersection = Math.max(
      Math.min(Math.max(y11, y12), Math.max(y21, y22)) - 
      Math.max(Math.min(y11, y12), Math.min(y21, y22)), 
      0
    );
    return intersection * vol / height;
  }

  function calculateFRVP(candleData, barsCount, rowSize, valueAreaPercent) {
    const data = candleData.slice(-barsCount);
    
    // Находим максимум и минимум
    let top = -Infinity;
    let bot = Infinity;
    
    data.forEach(bar => {
      top = Math.max(top, bar.high);
      bot = Math.min(bot, bar.low);
    });
    
    const step = (top - bot) / rowSize;
    
    // Создаём уровни
    const levels = [];
    for (let x = 0; x <= rowSize; x++) {
      levels.push(bot + step * x);
    }
    
    // Инициализируем массивы объёмов (up и down)
    const volumes = new Array(rowSize * 2).fill(0);
    
    // Расчёт объёма для каждой свечи
    data.forEach(candle => {
      const bodyTop = Math.max(candle.close, candle.open);
      const bodyBot = Math.min(candle.close, candle.open);
      const itsGreen = candle.close >= candle.open;
      
      const topWick = candle.high - bodyTop;
      const bottomWick = bodyBot - candle.low;
      const body = bodyTop - bodyBot;
      
      const totalHeight = 2 * topWick + 2 * bottomWick + body;
      const bodyVol = totalHeight > 0 ? body * candle.volume / totalHeight : 0;
      const topWickVol = totalHeight > 0 ? 2 * topWick * candle.volume / totalHeight : 0;
      const bottomWickVol = totalHeight > 0 ? 2 * bottomWick * candle.volume / totalHeight : 0;
      
      for (let x = 0; x < rowSize; x++) {
        const levelLow = levels[x];
        const levelHigh = levels[x + 1];
        
        // Объём тела свечи
        const bodyVolume = itsGreen ? 
          getVol(levelLow, levelHigh, bodyBot, bodyTop, body, bodyVol) : 0;
        const bodyVolumeDown = itsGreen ? 0 : 
          getVol(levelLow, levelHigh, bodyBot, bodyTop, body, bodyVol);
        
        // Объём фитилей
        const topWickVolume = getVol(levelLow, levelHigh, bodyTop, candle.high, topWick, topWickVol) / 2;
        const bottomWickVolume = getVol(levelLow, levelHigh, bodyBot, candle.low, bottomWick, bottomWickVol) / 2;
        
        volumes[x] += bodyVolume + topWickVolume + bottomWickVolume;
        volumes[x + rowSize] += bodyVolumeDown + topWickVolume + bottomWickVolume;
      }
    });
    
    // Суммарные объёмы
    const totalVols = [];
    for (let x = 0; x < rowSize; x++) {
      totalVols.push(volumes[x] + volumes[x + rowSize]);
    }
    
    // Находим POC
    let poc = 0;
    let maxVol = totalVols[0];
    for (let x = 1; x < rowSize; x++) {
      if (totalVols[x] > maxVol) {
        maxVol = totalVols[x];
        poc = x;
      }
    }
    
    // Расчёт Value Area
    const totalMax = totalVols.reduce((a, b) => a + b, 0) * valueAreaPercent / 100;
    let vaTotal = totalVols[poc];
    let up = poc;
    let down = poc;
    
    for (let x = 0; x < rowSize; x++) {
      if (vaTotal >= totalMax) break;
      
      const upperVol = up < rowSize - 1 ? totalVols[up + 1] : 0;
      const lowerVol = down > 0 ? totalVols[down - 1] : 0;
      
      if (upperVol === 0 && lowerVol === 0) break;
      
      if (upperVol >= lowerVol) {
        vaTotal += upperVol;
        up++;
      } else {
        vaTotal += lowerVol;
        down--;
      }
    }
    
    const pocLevel = (levels[poc] + levels[poc + 1]) / 2;
    const vahLevel = (levels[up] + levels[up + 1]) / 2;
    const valLevel = (levels[down] + levels[down + 1]) / 2;
    
    return {
      poc: pocLevel,
      vah: vahLevel,
      val: valLevel,
      levels,
      volumes,
      totalVols,
      pocIndex: poc,
      vahIndex: up,
      valIndex: down
    };
  }

  // ============================================================================
  // ФОРМАТИРОВАНИЕ СООБЩЕНИЯ
  // ============================================================================

  function formatMessage(symbol, currentPrice, frvp, settings) {
    const { poc, vah, val } = frvp;
    
    // Определяем позицию цены относительно уровней
    let position = '';
    let emoji = '';
    if (currentPrice > vah) {
      position = 'Выше Value Area (бычья зона)';
      emoji = '🟢';
    } else if (currentPrice < val) {
      position = 'Ниже Value Area (медвежья зона)';
      emoji = '🔴';
    } else if (currentPrice > poc) {
      position = 'В Value Area, выше POC';
      emoji = '🟡';
    } else {
      position = 'В Value Area, ниже POC';
      emoji = '🟡';
    }
    
    // Расстояние до уровней
    const distToPOC = ((currentPrice - poc) / poc * 100).toFixed(2);
    const distToVAH = ((currentPrice - vah) / vah * 100).toFixed(2);
    const distToVAL = ((currentPrice - val) / val * 100).toFixed(2);
    
    // Названия таймфреймов
    const intervalNames = {
      '1m': '1 минута',
      '5m': '5 минут',
      '15m': '15 минут',
      '30m': '30 минут',
      '1h': '1 час',
      '4h': '4 часа',
      '1d': '1 день',
      '1w': '1 неделя'
    };
    
    const intervalName = intervalNames[settings.interval] || settings.interval;
    if(currentPrice==poc){
          return `
  📊 *FRVP Volume Profile Analysis*

  ━━━━━━━━━━━━━━━━━━━━
  💰 *Символ:* ${symbol}
  ⏰ *Таймфрейм:* ${intervalName} (${settings.interval})
  ━━━━━━━━━━━━━━━━━━━━

  💵 *Текущая цена:* ${currentPrice.toFixed(2)}

  ${emoji} *${position}*

  ━━━━━━━━━━━━━━━━━━━━
  🎯 *Ключевые уровни FRVP:*

  🔴 *POC* (Point of Control)
    Цена: *${poc.toFixed(2)}*
    Расстояние: ${distToPOC > 0 ? '+' : ''}${distToPOC}%

  

  ━━━━━━━━━━━━━━━━━━━━
  ⚙️ *Параметры расчёта:*
  • Свечей: ${settings.barsCount}
  • Уровней: ${settings.rowSize}
  • Value Area: ${settings.valueAreaPercent}%

  ━━━━━━━━━━━━━━━━━━━━
  📈 *Торговые сигналы:*

  ${currentPrice > vah ? '🟢 *Бычий тренд*\n   Рассмотрите покупки при откате к VAH\n   Цель: новые максимумы' : ''}${currentPrice < val ? '🔴 *Медвежий тренд*\n   Рассмотрите продажи при отскоке к VAL\n   Цель: новые минимумы' : ''}${currentPrice >= val && currentPrice <= vah && currentPrice > poc ? '🟡 *Консолидация (выше POC)*\n   Ожидайте пробой VAH для покупок\n   Или возврат к POC для коррекции' : ''}${currentPrice >= val && currentPrice <= vah && currentPrice <= poc ? '🟡 *Консолидация (ниже POC)*\n   Ожидайте пробой VAL для продаж\n   Или возврат к POC для коррекции' : ''}

  ⏰ ${new Date().toLocaleString('ru-RU')}
  `;
    } 
    
    
    if(currentPrice==val){
          return `
  📊 *FRVP Volume Profile Analysis*

  ━━━━━━━━━━━━━━━━━━━━
  💰 *Символ:* ${symbol}
  ⏰ *Таймфрейм:* ${intervalName} (${settings.interval})
  ━━━━━━━━━━━━━━━━━━━━

  💵 *Текущая цена:* ${currentPrice}

  ${emoji} *${position}*

  ━━━━━━━━━━━━━━━━━━━━
  🎯 *Ключевые уровни VAL:*

  

  🔵 *VAL* (Value Area Low)
    Цена: *${val}*
    Расстояние: ${distToVAL > 0 ? '+' : ''}${distToVAL}%

  ━━━━━━━━━━━━━━━━━━━━
  ⚙️ *Параметры расчёта:*
  • Свечей: ${settings.barsCount}
  • Уровней: ${settings.rowSize}
  • Value Area: ${settings.valueAreaPercent}%

  ━━━━━━━━━━━━━━━━━━━━
  📈 *Торговые сигналы:*

  ${currentPrice > vah ? '🟢 *Бычий тренд*\n   Рассмотрите покупки при откате к VAH\n   Цель: новые максимумы' : ''}${currentPrice < val ? '🔴 *Медвежий тренд*\n   Рассмотрите продажи при отскоке к VAL\n   Цель: новые минимумы' : ''}${currentPrice >= val && currentPrice <= vah && currentPrice > poc ? '🟡 *Консолидация (выше POC)*\n   Ожидайте пробой VAH для покупок\n   Или возврат к POC для коррекции' : ''}${currentPrice >= val && currentPrice <= vah && currentPrice <= poc ? '🟡 *Консолидация (ниже POC)*\n   Ожидайте пробой VAL для продаж\n   Или возврат к POC для коррекции' : ''}

  ⏰ ${new Date().toLocaleString('ru-RU')}
  `;
  //     return `
  // 📊 *FRVP Volume Profile Analysis*

  // ━━━━━━━━━━━━━━━━━━━━
  // 💰 *Символ:* ${symbol}
  // ⏰ *Таймфрейм:* ${intervalName} (${settings.interval})
  // ━━━━━━━━━━━━━━━━━━━━

  // 💵 *Текущая цена:* ${currentPrice.toFixed(2)}

  // ${emoji} *${position}*

  // ━━━━━━━━━━━━━━━━━━━━
  // 🎯 *Ключевые уровни FRVP:*

  // 🔴 *POC* (Point of Control)
  //    Цена: *${poc.toFixed(2)}*
  //    Расстояние: ${distToPOC > 0 ? '+' : ''}${distToPOC}%

  // 🟢 *VAH* (Value Area High)
  //    Цена: *${vah.toFixed(2)}*
  //    Расстояние: ${distToVAH > 0 ? '+' : ''}${distToVAH}%

  // 🔵 *VAL* (Value Area Low)
  //    Цена: *${val.toFixed(2)}*
  //    Расстояние: ${distToVAL > 0 ? '+' : ''}${distToVAL}%

  // ━━━━━━━━━━━━━━━━━━━━
  // ⚙️ *Параметры расчёта:*
  // • Свечей: ${settings.barsCount}
  // • Уровней: ${settings.rowSize}
  // • Value Area: ${settings.valueAreaPercent}%

  // ━━━━━━━━━━━━━━━━━━━━
  // 📈 *Торговые сигналы:*

  // ${currentPrice > vah ? '🟢 *Бычий тренд*\n   Рассмотрите покупки при откате к VAH\n   Цель: новые максимумы' : ''}${currentPrice < val ? '🔴 *Медвежий тренд*\n   Рассмотрите продажи при отскоке к VAL\n   Цель: новые минимумы' : ''}${currentPrice >= val && currentPrice <= vah && currentPrice > poc ? '🟡 *Консолидация (выше POC)*\n   Ожидайте пробой VAH для покупок\n   Или возврат к POC для коррекции' : ''}${currentPrice >= val && currentPrice <= vah && currentPrice <= poc ? '🟡 *Консолидация (ниже POC)*\n   Ожидайте пробой VAL для продаж\n   Или возврат к POC для коррекции' : ''}

  // ⏰ ${new Date().toLocaleString('ru-RU')}
  // `;
    }
  // 
    
    
  }

  // ============================================================================
  // ASCII ВИЗУАЛИЗАЦИЯ
  // ============================================================================

  function createASCIIChart(frvp, currentPrice, height = 15) {
    const { levels, totalVols, pocIndex, vahIndex, valIndex } = frvp;
    const maxVol = Math.max(...totalVols);
    
    let chart = '\n```\n';
    chart += 'Volume Profile:\n\n';
    
    // Определяем диапазон для отображения
    const priceRange = levels[levels.length - 1] - levels[0];
    const priceStep = priceRange / height;
    
    for (let i = height - 1; i >= 0; i--) {
      const priceLevel = levels[0] + priceStep * i;
      const price = priceLevel.toFixed(2);
      
      // Находим ближайший индекс уровня
      let volumeIndex = Math.floor((priceLevel - levels[0]) / (levels[1] - levels[0]));
      volumeIndex = Math.max(0, Math.min(totalVols.length - 1, volumeIndex));
      
      const volume = totalVols[volumeIndex] || 0;
      const barLength = Math.round((volume / maxVol) * 30);
      const bar = '█'.repeat(barLength);
      
      // Маркеры уровней
      let marker = '';
      if (Math.abs(priceLevel - frvp.poc) < priceStep) {
        marker = ' ← POC';
      } else if (Math.abs(priceLevel - frvp.vah) < priceStep) {
        marker = ' ← VAH';
      } else if (Math.abs(priceLevel - frvp.val) < priceStep) {
        marker = ' ← VAL';
      } else if (Math.abs(priceLevel - currentPrice) < priceStep) {
        marker = ' ← PRICE';
      }
      
      chart += `${price.padStart(10)} |${bar}${marker}\n`;
    }
    
    chart += '```';
    return chart;
  }

  // ============================================================================
  // ОСНОВНАЯ ФУНКЦИЯ АНАЛИЗА И ОТПРАВКИ
  // ============================================================================

  async function sendFRVPAnalysis(chatId, settings, checkAlerts = false) {
    try {
      console.log(`📊 Запуск анализа для ${settings.symbol}...`);
      
      // Получаем данные
      const candleData = await getBinanceKlines(
        settings.symbol,
        settings.interval,
        settings.barsCount + 50
      );
      
      if (!candleData || candleData.length === 0) {
        throw new Error('Нет данных для анализа');
      }
      
      // Рассчитываем FRVP
      const frvp = calculateFRVP(
        candleData,
        settings.barsCount,
        settings.rowSize,
        settings.valueAreaPercent
      );
      
      const currentPrice = candleData[candleData.length - 1].close;
      
      // Проверяем алерты если включено
      if (checkAlerts && config.alerts.enabled) {
        await checkPriceAlerts(chatId, settings.symbol, settings.interval, currentPrice, frvp);
      }
      
      // Формируем сообщение
      const message = formatMessage(settings.symbol, currentPrice, frvp, settings);
      const chart = createASCIIChart(frvp, currentPrice);
      
      // Отправляем в Telegram
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId, chart, { parse_mode: 'Markdown' });
      
      console.log(`✅ Анализ отправлен в чат ${chatId}`);
      
    } catch (error) {
      // console.error('❌ Ошибка анализа:', error);
      // await bot.sendMessage(
      //   chatId, 
      //   `❌ Ошибка: ${error.message}\n\nПопробуйте изменить настройки или проверьте символ.`
      // );
    }
  }

  // ============================================================================
  // ПРОВЕРКА АЛЕРТОВ ПРИ ДОСТИЖЕНИИ УРОВНЕЙ
  // ============================================================================

  async function checkPriceAlerts(chatId, symbol, interval, currentPrice, frvp) {
    const key = `${symbol}_${interval}`;
    const previousPrice = priceHistory.get(key);
    
    // Сохраняем текущую цену
    priceHistory.set(key, currentPrice);
    
    if (!previousPrice) return; // Первый запуск, нет предыдущей цены
    
    const alerts = config.alerts.types;
    const { poc, vah, val } = frvp;
    
    // Получаем данные символа из конфига
    const symbolConfig = config.symbols.find(s => s.symbol === symbol);
    const emoji = symbolConfig ? symbolConfig.emoji : '';
    
    // Проверяем касание POC
    if (alerts.poc_touch.enabled) {
      const distToPOC = Math.abs((currentPrice - poc) / poc * 100);
      const prevDistToPOC = Math.abs((previousPrice - poc) / poc * 100);
      
      if (distToPOC < alerts.poc_touch.threshold && prevDistToPOC >= alerts.poc_touch.threshold) {
        await bot.sendMessage(chatId, `
  🔴 *АЛЕРТ: ${emoji} ${symbol}*
  ⏰ Таймфрейм: ${interval}

  ${alerts.poc_touch.message}
  💵 Цена: ${currentPrice}
  🎯 POC: ${poc}

  Высокая вероятность отскока от уровня!
  `, { parse_mode: 'Markdown' });
      }
    }
    
    // Проверяем пробой VAH
    if (alerts.vah_breakout.enabled) {
      if (previousPrice <= vah && currentPrice > vah) {
        await bot.sendMessage(chatId, `
  🟢 *АЛЕРТ: ${emoji} ${symbol}*
  ⏰ Таймфрейм: ${interval}

  ${alerts.vah_breakout.message}
  💵 Цена: ${currentPrice}
  🎯 VAH: ${vah}

  🚀 Бычий сигнал! Рассмотрите покупки!
  `, { parse_mode: 'Markdown' });
      }
    }
    
    // Проверяем пробой VAL
    if (alerts.val_breakdown.enabled) {
      if (previousPrice >= val && currentPrice < val) {
        await bot.sendMessage(chatId, `
  🔵 *АЛЕРТ: ${emoji} ${symbol}*
  ⏰ Таймфрейм: ${interval}

  ${alerts.val_breakdown.message}
  💵 Цена: ${currentPrice}
  🎯 VAL: ${val}

  📉 Медвежий сигнал! Рассмотрите продажи!
  `, { parse_mode: 'Markdown' });
      }
    }
    
    // Проверяем вход в Value Area
    if (alerts.entering_value_area.enabled) {
      const wasOutside = previousPrice > vah || previousPrice < val;
      const nowInside = currentPrice >= val && currentPrice <= vah;
      
      if (wasOutside && nowInside) {
        await bot.sendMessage(chatId, `
  🟡 *АЛЕРТ: ${emoji} ${symbol}*
  ⏰ Таймфрейм: ${interval}

  ${alerts.entering_value_area.message}
  💵 Цена: ${currentPrice}
  📊 Value Area: ${val.toFixed(2)} - ${vah.toFixed(2)}

  Ожидается консолидация в диапазоне.
  `, { parse_mode: 'Markdown' });
      }
    }
    
    // Проверяем выход из Value Area
    if (alerts.leaving_value_area.enabled) {
      const wasInside = previousPrice >= val && previousPrice <= vah;
      const nowOutside = currentPrice > vah || currentPrice < val;
      
      if (wasInside && nowOutside) {
        const direction = currentPrice > vah ? 'вверх ⬆️' : 'вниз ⬇️';
        await bot.sendMessage(chatId, `
  ⚠️ *АЛЕРТ: ${emoji} ${symbol}*
  ⏰ Таймфрейм: ${interval}

  ${alerts.leaving_value_area.message}
  💵 Цена: ${currentPrice}
  📊 Направление: ${direction}

  Начало нового тренда!
  `, { parse_mode: 'Markdown' });
      }
    }
  }

  // ============================================================================
  // КОМАНДЫ БОТА
  // ============================================================================

  // Команда /start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Инициализируем настройки для пользователя
    if (!userSettings.has(chatId)) {
      userSettings.set(chatId, {
        symbol: CONFIG.SYMBOL,
        interval: CONFIG.INTERVAL,
        barsCount: CONFIG.BARS_COUNT,
        rowSize: CONFIG.ROW_SIZE,
        valueAreaPercent: CONFIG.VALUE_AREA
      });
    }
    
    const welcomeMessage = `
  🤖 *Добро пожаловать в FRVP Volume Profile Bot!*

  Автоматические уведомления при достижении ключевых уровней POC, VAH, VAL.

  ━━━━━━━━━━━━━━━━━━━━
  🔔 *АВТОМАТИЧЕСКИЕ УВЕДОМЛЕНИЯ:*

  🔴 *POC* - при касании уровня
  🟢 *VAH* - при пробое вверх
  🔵 *VAL* - при пробое вниз

  ⏰ *Таймфреймы:* 15m, 1h, 4h, 1d
  💰 *Символы:* BTC, ETH, SOL, BNB, DOGE, LTC

  ━━━━━━━━━━━━━━━━━━━━
  ⚡ *БЫСТРЫЙ СТАРТ:*

  1️⃣ Нажмите кнопку ниже
  2️⃣ Выберите "Активировать ВСЁ"
  3️⃣ Получайте уведомления автоматически!

  ━━━━━━━━━━━━━━━━━━━━
  📚 *Дополнительно:*

  /quick - Быстрый анализ
  /analyze - Детальный анализ
  /alerts - Настройки уведомлений
  /help - Подробная справка
  `;

    const keyboard = {
      inline_keyboard: [
        [
          { 
            text: '🚀 АКТИВИРОВАТЬ МОНИТОРИНГ', 
            callback_data: 'start_monitoring' 
          }
        ],
        [
          { text: '⚡ Быстрый анализ', callback_data: 'goto_quick' },
          { text: '❓ Справка', callback_data: 'goto_help' }
        ]
      ]
    };
    
    await bot.sendMessage(chatId, welcomeMessage, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  });

  // Обработка кнопок стартового меню
  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    
    if (data === 'start_monitoring') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      // Перенаправляем на /monitor
      const keyboard = {
        inline_keyboard: [
          [
            { 
              text: '🚀 Активировать ВСЁ (Рекомендуется)', 
              callback_data: 'monitor_all_full' 
            }
          ],
          [
            { text: '₿ Только BTC', callback_data: 'monitor_btc_all' },
            { text: '⟠ Только ETH', callback_data: 'monitor_eth_all' }
          ],
          [
            { text: '◎ Только SOL', callback_data: 'monitor_sol_all' },
            { text: '🔶 Только BNB', callback_data: 'monitor_bnb_all' }
          ],
          [
            { text: '⚙️ Выбрать вручную', callback_data: 'monitor_selective' }
          ]
        ]
      };
      
      await bot.editMessageText(
        `🔔 *АКТИВАЦИЯ МОНИТОРИНГА*\n\n*Что будет отслеживаться:*\n🔴 Касание POC\n🟢 Пробой VAH\n🔵 Пробой VAL\n\n*Рекомендация:*\nИспользуйте "Активировать ВСЁ" для полного мониторинга всех основных криптовалют.\n\nВы получите уведомление ТОЛЬКО когда цена достигнет уровней!`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        }
      );
      return;
    }
    
    if (data === 'goto_quick') {
      await bot.answerCallbackQuery(callbackQuery.id);
      bot.emit('message', { text: '/quick', chat: { id: chatId } });
      return;
    }
    
    if (data === 'goto_help') {
      await bot.answerCallbackQuery(callbackQuery.id);
      bot.emit('message', { text: '/help', chat: { id: chatId } });
      return;
    }
  });

  // Команда /analyze
  bot.onText(/\/analyze/, async (msg) => {
    const chatId = msg.chat.id;
    const settings = userSettings.get(chatId) || {
      symbol: CONFIG.SYMBOL,
      interval: CONFIG.INTERVAL,
      barsCount: CONFIG.BARS_COUNT,
      rowSize: CONFIG.ROW_SIZE,
      valueAreaPercent: CONFIG.VALUE_AREA
    };
    
    // Показываем текущие настройки с кнопками
    const keyboard = {
      inline_keyboard: [
        [
          { text: '💰 Изменить символ', callback_data: 'change_symbol' },
          { text: '⏰ Изменить таймфрейм', callback_data: 'change_interval' }
        ],
        [
          { text: '✅ Запустить анализ', callback_data: 'run_analysis' }
        ]
      ]
    };
    
    const message = `
  📊 *Готов к анализу FRVP*

  Текущие настройки:
  💰 Символ: *${settings.symbol}*
  ⏰ Таймфрейм: *${settings.interval}*
  📊 Свечей: ${settings.barsCount}
  🎯 Уровней: ${settings.rowSize}
  📈 Value Area: ${settings.valueAreaPercent}%

  Нажмите "Запустить анализ" или измените настройки:
  `;
    
    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  });

  // Обработка кнопки "Запустить анализ"
  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    
    if (data === 'run_analysis') {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: '⏳ Запускаю анализ...'
      });
      
      await bot.editMessageText('⏳ Загрузка данных и расчёт FRVP...', {
        chat_id: chatId,
        message_id: messageId
      });
      
      const settings = userSettings.get(chatId) || {
        symbol: CONFIG.SYMBOL,
        interval: CONFIG.INTERVAL,
        barsCount: CONFIG.BARS_COUNT,
        rowSize: CONFIG.ROW_SIZE,
        valueAreaPercent: CONFIG.VALUE_AREA
      };
      
      await sendFRVPAnalysis(chatId, settings);
    }
    
    if (data === 'change_symbol') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: [
          [
            { text: '₿ BTC/USDT', callback_data: 'symbol_BTCUSDT' },
            { text: '⟠ ETH/USDT', callback_data: 'symbol_ETHUSDT' }
          ],
          [
            { text: '◎ SOL/USDT', callback_data: 'symbol_SOLUSDT' },
            { text: '🔶 BNB/USDT', callback_data: 'symbol_BNBUSDT' }
          ],
          [
            { text: '✕ XRP/USDT', callback_data: 'symbol_XRPUSDT' },
            { text: '₳ ADA/USDT', callback_data: 'symbol_ADAUSDT' }
          ],
          [
            { text: '🐕 DOGE/USDT', callback_data: 'symbol_DOGEUSDT' },
            { text: '🔺 AVAX/USDT', callback_data: 'symbol_AVAXUSDT' }
          ]
        ]
      };
      
      await bot.editMessageText('💰 Выберите торговую пару:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      });
    }
    
    if (data === 'change_interval') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: [
          [
            { text: '1️⃣ 1 минута', callback_data: 'interval_1m' },
            { text: '5️⃣ 5 минут', callback_data: 'interval_5m' },
            { text: '🕐 15 минут', callback_data: 'interval_15m' }
          ],
          [
            { text: '🕐 30 минут', callback_data: 'interval_30m' },
            { text: '⏰ 1 час', callback_data: 'interval_1h' },
            { text: '⏰ 4 часа', callback_data: 'interval_4h' }
          ],
          [
            { text: '📅 1 день', callback_data: 'interval_1d' },
            { text: '📅 1 неделя', callback_data: 'interval_1w' }
          ]
        ]
      };
      
      await bot.editMessageText('⏰ Выберите таймфрейм:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      });
    }
  });

  // Команда /settings
  bot.onText(/\/settings/, (msg) => {
    const chatId = msg.chat.id;
    const settings = userSettings.get(chatId) || {};
    
    const message = `
  ⚙️ *Текущие настройки:*

  • Символ: ${settings.symbol || CONFIG.SYMBOL}
  • Таймфрейм: ${settings.interval || CONFIG.INTERVAL}
  • Количество свечей: ${settings.barsCount || CONFIG.BARS_COUNT}
  • Количество уровней: ${settings.rowSize || CONFIG.ROW_SIZE}
  • Value Area %: ${settings.valueAreaPercent || CONFIG.VALUE_AREA}

  Для изменения используйте команды:
  /symbol, /interval, /bars, /rows, /va
  `;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  });

  // Изменение символа - с кнопками
  bot.onText(/\/symbol$/, (msg) => {
    const chatId = msg.chat.id;
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '₿ BTC/USDT', callback_data: 'symbol_BTCUSDT' },
          { text: '⟠ ETH/USDT', callback_data: 'symbol_ETHUSDT' }
        ],
        [
          { text: '◎ SOL/USDT', callback_data: 'symbol_SOLUSDT' },
          { text: '🔶 BNB/USDT', callback_data: 'symbol_BNBUSDT' }
        ],
        [
          { text: '✕ XRP/USDT', callback_data: 'symbol_XRPUSDT' },
          { text: '₳ ADA/USDT', callback_data: 'symbol_ADAUSDT' }
        ],
        [
          { text: '🐕 DOGE/USDT', callback_data: 'symbol_DOGEUSDT' },
          { text: '🔺 AVAX/USDT', callback_data: 'symbol_AVAXUSDT' }
        ],
        [
          { text: '🔗 LINK/USDT', callback_data: 'symbol_LINKUSDT' },
          { text: '◈ MATIC/USDT', callback_data: 'symbol_MATICUSDT' }
        ]
      ]
    };
    
    bot.sendMessage(chatId, '💰 Выберите торговую пару:', {
      reply_markup: keyboard
    });
  });

  // Команда для ручного ввода символа
  bot.onText(/\/symbol (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const symbol = match[1].toUpperCase();
    
    const settings = userSettings.get(chatId) || {};
    settings.symbol = symbol;
    userSettings.set(chatId, settings);
    
    bot.sendMessage(chatId, `✅ Символ изменён на: ${symbol}`);
  });

  // Изменение таймфрейма - с кнопками
  bot.onText(/\/interval$/, (msg) => {
    const chatId = msg.chat.id;
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🕐 15 минут', callback_data: 'interval_15m' },
          { text: '⏰ 1 час', callback_data: 'interval_1h' }
        ],
        [
          { text: '⏰ 4 часа', callback_data: 'interval_4h' },
          { text: '📅 1 день', callback_data: 'interval_1d' }
        ],
        [
          { text: '📅 1 неделя', callback_data: 'interval_1w' }
        ],
        [
          { text: '⬅️ Другие таймфреймы', callback_data: 'interval_more' }
        ]
      ]
    };
    
    bot.sendMessage(chatId, '⏰ Выберите таймфрейм:\n\n*Рекомендуемые:* 15m, 1h, 4h, 1d, 1w', {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
  });

  // Команда для ручного ввода таймфрейма
  bot.onText(/\/interval (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const interval = match[1];
    
    const settings = userSettings.get(chatId) || {};
    settings.interval = interval;
    userSettings.set(chatId, settings);
    
    const intervalNames = {
      '1m': '1 минута',
      '5m': '5 минут',
      '15m': '15 минут',
      '30m': '30 минут',
      '1h': '1 час',
      '4h': '4 часа',
      '1d': '1 день',
      '1w': '1 неделя'
    };
    
    bot.sendMessage(chatId, `✅ Таймфрейм изменён на: ${intervalNames[interval] || interval}`);
  });

  // Изменение количества баров
  bot.onText(/\/bars (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const bars = parseInt(match[1]);
    
    if (bars < 50 || bars > 500) {
      bot.sendMessage(chatId, '❌ Количество баров должно быть от 50 до 500');
      return;
    }
    
    const settings = userSettings.get(chatId) || {};
    settings.barsCount = bars;
    userSettings.set(chatId, settings);
    
    bot.sendMessage(chatId, `✅ Количество баров изменено на: ${bars}`);
  });

  // Изменение количества уровней
  bot.onText(/\/rows (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const rows = parseInt(match[1]);
    
    if (rows < 10 || rows > 100) {
      bot.sendMessage(chatId, '❌ Количество уровней должно быть от 10 до 100');
      return;
    }
    
    const settings = userSettings.get(chatId) || {};
    settings.rowSize = rows;
    userSettings.set(chatId, settings);
    
    bot.sendMessage(chatId, `✅ Количество уровней изменено на: ${rows}`);
  });

  // Изменение Value Area
  bot.onText(/\/va (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const va = parseFloat(match[1]);
    
    if (va < 50 || va > 100) {
      bot.sendMessage(chatId, '❌ Value Area должна быть от 50 до 100');
      return;
    }
    
    const settings = userSettings.get(chatId) || {};
    settings.valueAreaPercent = va;
    userSettings.set(chatId, settings);
    
    bot.sendMessage(chatId, `✅ Value Area изменена на: ${va}%`);
  });

  // ============================================================================
  // ОБРАБОТКА CALLBACK КНОПОК
  // ============================================================================

  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    
    // Получаем настройки пользователя
    const settings = userSettings.get(chatId) || {
      symbol: CONFIG.SYMBOL,
      interval: CONFIG.INTERVAL,
      barsCount: CONFIG.BARS_COUNT,
      rowSize: CONFIG.ROW_SIZE,
      valueAreaPercent: CONFIG.VALUE_AREA
    };
    
    // Кнопка "Запустить анализ"
    if (data === 'run_analysis') {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: '⏳ Запускаю анализ...'
      });
      
      await bot.editMessageText('⏳ Загрузка данных и расчёт FRVP...', {
        chat_id: chatId,
        message_id: messageId
      });
      
      await sendFRVPAnalysis(chatId, settings);
      return;
    }
    
    // Кнопка "Изменить символ"
    if (data === 'change_symbol') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: [
          [
            { text: '₿ BTC/USDT', callback_data: 'symbol_BTCUSDT' },
            { text: '⟠ ETH/USDT', callback_data: 'symbol_ETHUSDT' }
          ],
          [
            { text: '◎ SOL/USDT', callback_data: 'symbol_SOLUSDT' },
            { text: '🔶 BNB/USDT', callback_data: 'symbol_BNBUSDT' }
          ],
          [
            { text: '✕ XRP/USDT', callback_data: 'symbol_XRPUSDT' },
            { text: '₳ ADA/USDT', callback_data: 'symbol_ADAUSDT' }
          ],
          [
            { text: '🐕 DOGE/USDT', callback_data: 'symbol_DOGEUSDT' },
            { text: '🔺 AVAX/USDT', callback_data: 'symbol_AVAXUSDT' }
          ]
        ]
      };
      
      await bot.editMessageText('💰 Выберите торговую пару:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      });
      return;
    }
    
    // Кнопка "Изменить таймфрейм"
    if (data === 'change_interval') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: [
          [
            { text: '🕐 15 минут', callback_data: 'interval_15m' },
            { text: '⏰ 1 час', callback_data: 'interval_1h' }
          ],
          [
            { text: '⏰ 4 часа', callback_data: 'interval_4h' },
            { text: '📅 1 день', callback_data: 'interval_1d' }
          ],
          [
            { text: '📅 1 неделя', callback_data: 'interval_1w' }
          ],
          [
            { text: '⬅️ Другие таймфреймы', callback_data: 'interval_more' }
          ]
        ]
      };
      
      await bot.editMessageText('⏰ Выберите таймфрейм:\n\n*Рекомендуемые:* 15m, 1h, 4h, 1d, 1w', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      });
      return;
    }
    
    // Показать дополнительные таймфреймы
    if (data === 'interval_more') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: [
          [
            { text: '1️⃣ 1 минута', callback_data: 'interval_1m' },
            { text: '5️⃣ 5 минут', callback_data: 'interval_5m' }
          ],
          [
            { text: '🕐 30 минут', callback_data: 'interval_30m' },
            { text: '📅 3 дня', callback_data: 'interval_3d' }
          ],
          [
            { text: '⬅️ Назад', callback_data: 'change_interval' }
          ]
        ]
      };
      
      await bot.editMessageText('⏰ Дополнительные таймфреймы:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      });
      return;
    }
    
    // Обработка выбора символа
    if (data.startsWith('symbol_')) {
      const symbol = data.replace('symbol_', '');
      settings.symbol = symbol;
      userSettings.set(chatId, settings);
      
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `✅ Выбрано: ${symbol}`
      });
      
      const intervalNames = {
        '1m': '1 минута',
        '5m': '5 минут',
        '15m': '15 минут',
        '30m': '30 минут',
        '1h': '1 час',
        '4h': '4 часа',
        '1d': '1 день',
        '3d': '3 дня',
        '1w': '1 неделя'
      };
      
      // Создаём кнопки для быстрых действий
      const quickActions = {
        inline_keyboard: [
          [
            { text: '✅ Запустить анализ сейчас', callback_data: 'run_analysis' }
          ],
          [
            { text: '⏰ Изменить таймфрейм', callback_data: 'change_interval' }
          ]
        ]
      };
      
      await bot.editMessageText(
        `✅ Символ изменён на: *${symbol}*\n\n📊 Текущие настройки:\n💰 Символ: *${symbol}*\n⏰ Таймфрейм: *${intervalNames[settings.interval] || settings.interval}*\n\nГотово к анализу!`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: quickActions
        }
      );
      return;
    }
    
    // Обработка выбора таймфрейма
    if (data.startsWith('interval_')) {
      const interval = data.replace('interval_', '');
      settings.interval = interval;
      userSettings.set(chatId, settings);
      
      const intervalNames = {
        '1m': '1 минута',
        '5m': '5 минут',
        '15m': '15 минут',
        '30m': '30 минут',
        '1h': '1 час',
        '4h': '4 часа',
        '1d': '1 день',
        '3d': '3 дня',
        '1w': '1 неделя'
      };
      
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `✅ Выбрано: ${intervalNames[interval]}`
      });
      
      // Создаём кнопку для быстрого запуска анализа
      const quickAnalyze = {
        inline_keyboard: [
          [
            { text: '✅ Запустить анализ сейчас', callback_data: 'run_analysis' }
          ],
          [
            { text: '💰 Изменить символ', callback_data: 'change_symbol' }
          ]
        ]
      };
      
      await bot.editMessageText(
        `✅ Таймфрейм изменён на: *${intervalNames[interval]}*\n\n📊 Символ: *${settings.symbol}*\n⏰ Таймфрейм: *${intervalNames[interval]}*\n\nГотово к анализу!`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: quickAnalyze
        }
      );
      return;
    }
    
    // Показать все символы
    if (data === 'quick_all_symbols') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: []
      };
      
      // Показываем все символы из конфига
      config.symbols.forEach(symbolConfig => {
        keyboard.inline_keyboard.push([
          { 
            text: `${symbolConfig.emoji} ${symbolConfig.name}`, 
            callback_data: `select_symbol_${symbolConfig.symbol}` 
          }
        ]);
      });
      
      keyboard.inline_keyboard.push([
        { text: '⬅️ Назад', callback_data: 'back_to_quick' }
      ]);
      
      await bot.editMessageText('💰 Выберите символ:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      });
      return;
    }
    
    // Возврат к quick меню
    if (data === 'back_to_quick') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: []
      };
      
      const prioritySymbols = config.symbols
        .filter(s => s.priority <= 4)
        .sort((a, b) => a.priority - b.priority);
      
      prioritySymbols.forEach(symbolConfig => {
        const row = [
          { 
            text: `${symbolConfig.emoji} ${symbolConfig.name} 1h`, 
            callback_data: `quick_${symbolConfig.symbol}_1h` 
          },
          { 
            text: `${symbolConfig.emoji} ${symbolConfig.name} 4h`, 
            callback_data: `quick_${symbolConfig.symbol}_4h` 
          },
          { 
            text: `${symbolConfig.emoji} ${symbolConfig.name} 1d`, 
            callback_data: `quick_${symbolConfig.symbol}_1d` 
          }
        ];
        keyboard.inline_keyboard.push(row);
      });
      
      keyboard.inline_keyboard.push([
        { text: '📋 Все символы', callback_data: 'quick_all_symbols' }
      ]);
      
      await bot.editMessageText('⚡ *Быстрый анализ*\n\nВыберите символ и таймфрейм:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      });
      return;
    }
    
    // Выбор символа из полного списка
    if (data.startsWith('select_symbol_')) {
      const symbol = data.replace('select_symbol_', '');
      const symbolConfig = config.symbols.find(s => s.symbol === symbol);
      
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: []
      };
      
      // Показываем все доступные интервалы для этого символа
      const intervals = symbolConfig.intervals || ['15m', '1h', '4h', '1d', '1w'];
      const intervalRows = [];
      
      for (let i = 0; i < intervals.length; i += 3) {
        const row = intervals.slice(i, i + 3).map(interval => ({
          text: config.intervals[interval].name,
          callback_data: `quick_${symbol}_${interval}`
        }));
        intervalRows.push(row);
      }
      
      keyboard.inline_keyboard = [...intervalRows, [
        { text: '⬅️ Назад', callback_data: 'quick_all_symbols' }
      ]];
      
      await bot.editMessageText(`${symbolConfig.emoji} *${symbolConfig.name}*\n\nВыберите таймфрейм:`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      });
      return;
    }
    
    // Обработка быстрого анализа
    if (data.startsWith('quick_')) {
      const parts = data.replace('quick_', '').split('_');
      const symbol = parts[0];
      const interval = parts[1];
      
      settings.symbol = symbol;
      settings.interval = interval;
      userSettings.set(chatId, settings);
      
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `⚡ Запускаю ${symbol} ${interval}...`
      });
      
      await bot.editMessageText(`⏳ Анализ ${symbol} (${interval})...\n\nЗагрузка данных с биржи...`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      await sendFRVPAnalysis(chatId, settings);
      return;
    }
    
    // Обработка выбора частоты обновлений
    if (data.startsWith('schedule_')) {
      const frequency = data.replace('schedule_', '');
      
      const frequencyNames = {
        'off': 'Выключено',
        'minute': 'Каждую минуту',
        'hourly': 'Каждый час',
        'daily': 'Каждый день'
      };
      
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `✅ Установлено: ${frequencyNames[frequency]}`
      });
      
      await bot.editMessageText(
        `✅ Автообновления: *${frequencyNames[frequency]}*\n\n${frequency !== 'off' ? '⏰ Вы будете получать автоматические обновления FRVP анализа!' : ''}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        }
      );
      
      // Сохраняем настройку автообновлений
      settings.autoUpdate = frequency;
      userSettings.set(chatId, settings);
      return;
    }
  });

  // Команда /monitor - Быстрая активация полного мониторинга
  bot.onText(/\/monitor/, async (msg) => {
    const chatId = msg.chat.id;
    
    const keyboard = {
      inline_keyboard: [
        [
          { 
            text: '🚀 Активировать ВСЁ (Все символы + таймфреймы)', 
            callback_data: 'monitor_all_full' 
          }
        ],
        [
          { text: '₿ BTC (15m, 1h, 4h, 1d)', callback_data: 'monitor_btc_all' },
        ],
        [
          { text: '⟠ ETH (15m, 1h, 4h, 1d)', callback_data: 'monitor_eth_all' }
        ],
        [
          { text: '◎ SOL (15m, 1h, 4h, 1d)', callback_data: 'monitor_sol_all' }
        ],
        [
          { text: '🔶 BNB (15m, 1h, 4h, 1d)', callback_data: 'monitor_bnb_all' }
        ],
        [
          { text: '🐕 DOGE (15m, 1h, 4h, 1d)', callback_data: 'monitor_doge_all' }
        ],
        [
          { text: 'Ł LTC (15m, 1h, 4h, 1d)', callback_data: 'monitor_ltc_all' }
        ],
        [
          { text: '⚙️ Выборочно', callback_data: 'monitor_selective' }
        ]
      ]
    };
    
    const message = `
  🔔 *АВТОМАТИЧЕСКИЙ МОНИТОРИНГ УРОВНЕЙ*

  ━━━━━━━━━━━━━━━━━━━━
  *Что будет отслеживаться:*

  🔴 *POC Touch* - Касание уровня максимального объёма
  🟢 *VAH Breakout* - Пробой верхней границы вверх
  🔵 *VAL Breakdown* - Пробой нижней границы вниз

  ━━━━━━━━━━━━━━━━━━━━
  *Таймфреймы мониторинга:*

  🕐 15m - проверка каждые 15 минут
  ⏰ 1h - проверка каждый час
  ⏰ 4h - проверка каждые 4 часа
  📅 1d - проверка каждый день в 9:00

  ━━━━━━━━━━━━━━━━━━━━
  ⚡ *Рекомендация:*

  Используйте "Активировать ВСЁ" для мониторинга всех основных криптовалют на всех таймфреймах.

  Вы будете получать уведомления ТОЛЬКО при достижении ключевых уровней!
  `;
    
    bot.sendMessage(chatId, message, {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
  });

  // Обработка активации полного мониторинга
  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    
    // Активация ПОЛНОГО мониторинга (все символы + все таймфреймы)
    if (data === 'monitor_all_full') {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: '🚀 Активирую полный мониторинг...'
      });
      
      await bot.editMessageText(
        '⏳ Активация мониторинга...\n\nНастройка автоматических проверок для всех символов и таймфреймов...',
        {
          chat_id: chatId,
          message_id: messageId
        }
      );
        
        // Активируем мониторинг для всех символов
      const monitoringSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT  ', 'DOGEUSDT', 'LTCUSDT','IDUSDT','PEPEUSDT','SUIUSDT','FILUSDT','EDUUSDT','ZECUSDT','ZENUSDT','FILUSDT','ICPUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 
'TRXUSDT', 'LINKUSDT', 'MATICUSDT', 'BCHUSDT', 'LTCUSDT', 'NEARUSDT', 'FILUSDT', 'ATOMUSDT', 'APTUSDT', 'OPUSDT', 
'STXUSDT', 'HBARUSDT', 'XLMUSDT', 'VETUSDT', 'FETUSDT', 'GALAUSDT', 'FTMUSDT', 'ALGOUSDT', 'FLOWUSDT', 
'EGLDUSDT', 'QNTUSDT', 'AGIXUSDT', 'MINAUSDT', 'MANAUSDT', 'APEUSDT', 'CHZUSDT', 'XECUSDT', 'CFXUSDT', 'ROSEUSDT', 
'JASMYUSDT', 'IOTAUSDT', 'LPTUSDT', 'GMTUSDT', 'TWTUSDT', 'GLMUSDT', 'ZILUSDT', 'CELOUSDT', 'SCUSDT', 'QTUMUSDT', 'SKLUSDT', 
'ZECUSDT', 'MASKUSDT', 'XEMUSDT', 'DASHUSDT', 'WAVESUSDT', 'PONDUSDT', 'TRBUSDT', 'STRAXUSDT', 'MOVRUSDT', 'SCRTUSDT', 'CELRUSDT',
 'PHBUSDT', 'DUSKUSDT', 'CTXCUSDT', 'OMGUSDT', 'ACHUSDT', 'ONGUSDT', 'BLZUSDT', 'LOOMUSDT', 'AGLDUSDT', 'PHAUSDT', 'NKNUSDT',
  'STMXUSDT', 'STORJUSDT', 'ARDRUSDT', 'RADUSDT', 'CTKUSDT', 'OGNUSDT', 'REQUSDT', 'RAREUSDT', 'ARPAUSDT', 'MDTUSDT', 'ATAUSDT',
   'DATAUSDT', 'IRISUSDT', 'FIDAUSDT', 'KMDUSDT', 'AVAUSDT', 'NULSUSDT', 'SANTOSUSDT', 'VIDTUSDT', 'DREPUSDT', 'BURGERUSDT', 
   'OGUSDT', 'FIOUSDT', 'FIROUSDT','IDUSDT','SYSUSDT','COSUSDT','TWTUSDT','QTUMUSDT','GRTUSDT','EOSUSDT','DCRUSDT', 'OXTUSDT','WTCUSDT', 'PUNDIXUSDT', 'TFUELUSDT', 'SXPUSDT',  'XMRUSDT','BICOUSDT',  'CKBUSDT',  'SFPUSDT','TVKUSDT','PAXGUSDT', 'POWRUSDT','GASUSDT','QKCUSDT', 'PROMUSDT',  'RLCUSDT', 'VTHOUSDT',   'DOCKUSDT',  'HIVEUSDT', 'AMPUSDT', 'BANDUSDT','MTLUSDT'];
      const monitoringIntervals = ['5m','15m', '1h', '4h', '1d','1w'];
      
      // Сохраняем настройки
      const settings = userSettings.get(chatId) || {};
      settings.fullMonitoring = {
        enabled: true,
        symbols: monitoringSymbols,
        intervals: monitoringIntervals,
        startTime: Date.now()
      };
      userSettings.set(chatId, settings);
      
      let statusMessage = '✅ *МОНИТОРИНГ АКТИВИРОВАН!*\n\n';
      statusMessage += '━━━━━━━━━━━━━━━━━━━━\n';
      statusMessage += '*Отслеживаемые символы:*\n\n';
      
      monitoringSymbols.forEach(symbol => {
        const symbolConfig = config.symbols.find(s => s.symbol === symbol);
        if (symbolConfig) {
          statusMessage += `${symbolConfig.emoji} ${symbolConfig.name}\n`;
        }
      });
      
      statusMessage += '\n━━━━━━━━━━━━━━━━━━━━\n';
      statusMessage += '*Таймфреймы:*\n';
      statusMessage += '• 15m - каждые 15 минут\n';
      statusMessage += '• 1h - каждый час\n';
      statusMessage += '• 4h - каждые 4 часа\n';
      statusMessage += '• 1d - каждый день в 9:00\n\n';
      
      statusMessage += '━━━━━━━━━━━━━━━━━━━━\n';
      statusMessage += '*Алерты при:*\n';
      statusMessage += '🔴 POC Touch\n';
      statusMessage += '🟢 VAH Breakout\n';
      statusMessage += '🔵 VAL Breakdown\n\n';
      
      statusMessage += '🔔 Первые уведомления придут в ближайшее время!\n\n';
      statusMessage += 'Управление: /monitor';
      
      await bot.editMessageText(statusMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });
      
      // Запускаем первую проверку для всех
      setTimeout(async () => {
        await bot.sendMessage(chatId, '🔄 Запускаю первичную проверку всех уровней...');
        
        for (const symbol of monitoringSymbols) {
          for (const interval of monitoringIntervals) {
            try {
              const intervalConfig = config.intervals[interval];
              const analysisSettings = {
                symbol: symbol,
                interval: interval,
                barsCount: intervalConfig.barsCount,
                rowSize: config.settings.rowSize,
                valueAreaPercent: config.settings.valueAreaPercent
              };
              
              // Запускаем анализ с проверкой алертов
              await sendFRVPAnalysis(chatId, analysisSettings, true);
              
              // Задержка между запросами
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
              console.error(`Ошибка при первичной проверке ${symbol} ${interval}:`, error);
            }
          }
        }
        
        await bot.sendMessage(chatId, '✅ Первичная проверка завершена!\n\n🔔 Теперь вы будете получать уведомления автоматически при достижении уровней.');
      }, 3000);
      
      return;
    }
    
    // Мониторинг отдельного символа на всех таймфреймах
    if (data.startsWith('monitor_') && data.endsWith('_all')) {
      const symbolName = data.replace('monitor_', '').replace('_all', '').toUpperCase();
      
      let symbol;
      switch(symbolName) {
        case 'BTC': symbol = 'BTCUSDT'; break;
        case 'ETH': symbol = 'ETHUSDT'; break;
        case 'SOL': symbol = 'SOLUSDT'; break;
        case 'BNB': symbol = 'BNBUSDT'; break;
        case 'DOGE': symbol = 'DOGEUSDT'; break;
        case 'LTC': symbol = 'LTCUSDT'; break;
        default: return;
      }
      
      const symbolConfig = config.symbols.find(s => s.symbol === symbol);
      const monitoringIntervals = ['5m','15m', '1h', '4h', '1d','1w'];
      
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `✅ Мониторинг ${symbolConfig.emoji} ${symbolConfig.name} активирован!`
      });
      
      // Сохраняем настройки
      const settings = userSettings.get(chatId) || {};
      if (!settings.symbolMonitoring) {
        settings.symbolMonitoring = {};
      }
      settings.symbolMonitoring[symbol] = {
        enabled: true,
        intervals: monitoringIntervals,
        startTime: Date.now()
      };
      userSettings.set(chatId, settings);
      
      await bot.editMessageText(
        `✅ *Мониторинг активирован!*\n\n${symbolConfig.emoji} Символ: *${symbolConfig.name}*\n\n*Таймфреймы:*\n• 15m - каждые 15 минут\n• 1h - каждый час\n• 4h - каждые 4 часа\n• 1d - каждый день\n\n🔔 Алерты: POC, VAH, VAL\n\n⏳ Запускаю первичную проверку...`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        }
      );
      
      // Первичная проверка
      setTimeout(async () => {
        for (const interval of monitoringIntervals) {
          const intervalConfig = config.intervals[interval];
          const analysisSettings = {
            symbol: symbol,
            interval: interval,
            barsCount: intervalConfig.barsCount,
            rowSize: config.settings.rowSize,
            valueAreaPercent: config.settings.valueAreaPercent
          };
          
          await sendFRVPAnalysis(chatId, analysisSettings, true);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        await bot.sendMessage(chatId, `✅ ${symbolConfig.emoji} ${symbolConfig.name} - мониторинг запущен!`);
      }, 2000);
      
      return;
    }
  });
  bot.onText(/\/alerts/, (msg) => {
    const chatId = msg.chat.id;
    
    const alertsStatus = config.alerts.enabled ? '✅ Включены' : '❌ Выключены';
    
    const keyboard = {
      inline_keyboard: [
        [
          { 
            text: config.alerts.enabled ? '❌ Выключить все алерты' : '✅ Включить все алерты', 
            callback_data: 'toggle_alerts' 
          }
        ],
        [
          { text: '🔔 Настроить мониторинг', callback_data: 'setup_monitoring' }
        ],
        [
          { text: '📊 Тестовый алерт', callback_data: 'test_alert' }
        ]
      ]
    };
    
    const pocStatus = config.alerts.types.poc_touch.enabled ? '✅' : '❌';
    const vahStatus = config.alerts.types.vah_breakout.enabled ? '✅' : '❌';
    const valStatus = config.alerts.types.val_breakdown.enabled ? '✅' : '❌';
    
    const message = `
  🔔 *Настройка автоматических алертов*

  Общий статус: ${alertsStatus}

  ━━━━━━━━━━━━━━━━━━━━
  *Активные типы алертов:*

  ${pocStatus} *POC Touch* (Касание)
    ${config.alerts.types.poc_touch.description}

  ${vahStatus} *VAH Breakout* (Пробой вверх)
    ${config.alerts.types.vah_breakout.description}

  ${valStatus} *VAL Breakdown* (Пробой вниз)
    ${config.alerts.types.val_breakdown.description}

  ━━━━━━━━━━━━━━━━━━━━
  ⚙️ *Как работает:*

  Бот автоматически проверяет цены по расписанию:
  • 15m - каждые 15 минут
  • 1h - каждый час
  • 4h - каждые 4 часа
  • 1d - каждый день в 9:00

  При достижении уровней вы получите уведомление с торговыми рекомендациями!

  💡 *Настройте мониторинг* для автоматического отслеживания ваших любимых символов.
  `;
    
    bot.sendMessage(chatId, message, {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
  });

  // Настройка мониторинга
  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    
    if (data === 'setup_monitoring') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: []
      };
      
      // Показываем символы для мониторинга
      config.symbols.slice(0, 6).forEach(symbolConfig => {
        keyboard.inline_keyboard.push([
          {
            text: `${symbolConfig.emoji} ${symbolConfig.name}`,
            callback_data: `monitor_symbol_${symbolConfig.symbol}`
          }
        ]);
      });
      
      keyboard.inline_keyboard.push([
        { text: '⬅️ Назад', callback_data: 'back_to_alerts' }
      ]);
      
      await bot.editMessageText(
        `🔔 *Настройка мониторинга*\n\nВыберите символ для отслеживания:`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );
      return;
    }
    
    // Выбор символа для мониторинга
    if (data.startsWith('monitor_symbol_')) {
      const symbol = data.replace('monitor_symbol_', '');
      const symbolConfig = config.symbols.find(s => s.symbol === symbol);
      
      await bot.answerCallbackQuery(callbackQuery.id);
      
      const keyboard = {
        inline_keyboard: [
          [
            { text: '🕐 5 минут', callback_data: `monitor_${symbol}_5m` },
       
            { text: '🕐 15 минут', callback_data: `monitor_${symbol}_15m` },
            { text: '⏰ 1 час', callback_data: `monitor_${symbol}_1h` }
          ],
          [
            { text: '⏰ 4 часа', callback_data: `monitor_${symbol}_4h` },
            { text: '📅 1 день', callback_data: `monitor_${symbol}_1d` }
          ],
          [
            { text: '⬅️ Назад', callback_data: 'setup_monitoring' }
          ]
        ]
      };
      
      await bot.editMessageText(
        `${symbolConfig.emoji} *${symbolConfig.name}*\n\nВыберите таймфрейм для мониторинга:`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );
      return;
    }
    
    // Активация мониторинга
    if (data.startsWith('monitor_') && !data.startsWith('monitor_symbol_')) {
      const parts = data.replace('monitor_', '').split('_');
      const symbol = parts[0];
      const interval = parts[1];
      
      const symbolConfig = config.symbols.find(s => s.symbol === symbol);
      const intervalConfig = config.intervals[interval];
      
      // Сохраняем настройки мониторинга
      const settings = userSettings.get(chatId) || {};
      settings.autoUpdate = true;
      settings.autoInterval = interval;
      settings.symbol = symbol;
      settings.interval = interval;
      settings.barsCount = intervalConfig.barsCount;
      settings.rowSize = config.settings.rowSize;
      settings.valueAreaPercent = config.settings.valueAreaPercent;
      userSettings.set(chatId, settings);
      
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `✅ Мониторинг активирован!`
      });
      
      await bot.editMessageText(
        `✅ *Мониторинг активирован!*\n\n${symbolConfig.emoji} Символ: *${symbolConfig.name}*\n⏰ Таймфрейм: *${intervalConfig.name}*\n\n🔔 Вы будете получать уведомления при:\n• Касании POC\n• Пробое VAH (бычий сигнал)\n• Пробое VAL (медвежий сигнал)\n\n📊 Проверка каждые: ${intervalConfig.name}\n\nЧтобы изменить настройки, используйте /alerts`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        }
      );
      
      // Отправляем первый анализ
      await sendFRVPAnalysis(chatId, settings, true);
      return;
    }
    
    // Тестовый алерт
    if (data === 'test_alert') {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: '📤 Отправка тестового алерта...'
      });
      
      await bot.sendMessage(chatId, `
  🟢 *ТЕСТОВЫЙ АЛЕРТ: ₿ Bitcoin*
  ⏰ Таймфрейм: 1h

  *Пробой VAH - Бычий сигнал!* 🚀

  ━━━━━━━━━━━━━━━━━━━━
  💵 Цена: $45,234.56
  🎯 VAH: $45,000.00
  📊 Выше на: +0.52%

  ━━━━━━━━━━━━━━━━━━━━
  🎯 *Торговая стратегия:*

  📈 *ПОКУПКА:*
  • Вход: $45,000
  • Stop Loss: $44,500
  • Take Profit: $45,900

  ✅ Это пример того, как будут выглядеть реальные алерты!
  `, { parse_mode: 'Markdown' });
      return;
    }
    
    // Возврат к алертам
    if (data === 'back_to_alerts') {
      await bot.answerCallbackQuery(callbackQuery.id);
      
      // Повторно отправляем меню алертов
      bot.emit('message', { text: '/alerts', chat: { id: chatId } });
      return;
    }
  });
  bot.onText(/\/schedule/, (msg) => {
    const chatId = msg.chat.id;
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: '⏸️ Выключить', callback_data: 'schedule_off' }
        ],
        [
          { text: '⏱️ Каждую минуту', callback_data: 'schedule_minute' }
        ],
        [
          { text: '⏰ Каждый час', callback_data: 'schedule_hourly' }
        ],
        [
          { text: '📅 Каждый день', callback_data: 'schedule_daily' }
        ]
      ]
    };
    
    bot.sendMessage(chatId, '⏰ Настройка автоматических обновлений:', {
      reply_markup: keyboard
    });
  });

  // Команда /help
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    
    const helpMessage = `
  📖 *Справка по боту*

  *Что такое FRVP?*
  Fixed Range Volume Profile показывает, на каких ценовых уровнях было больше всего торговой активности.

  *Ключевые уровни:*
  • *POC* (Point of Control) - уровень с максимальным объёмом
  • *VAH* (Value Area High) - верхняя граница зоны активной торговли
  • *VAL* (Value Area Low) - нижняя граница зоны активной торговли

  *Быстрый старт:*
  1. /quick - Быстрый анализ популярных пар
  2. /symbol - Выбрать символ
  3. /interval - Выбрать таймфрейм (15m, 1h, 4h, 1d, 1w)
  4. /analyze - Запустить анализ

  *Торговые сигналы:*
  🟢 Цена выше VAH - бычий тренд
  🔴 Цена ниже VAL - медвежий тренд
  🟡 Цена в Value Area - консолидация

  *Дополнительные настройки:*
  /bars - Количество свечей (50-500)
  /rows - Количество уровней (10-100)
  /va - Value Area процент (50-100)
  /schedule - Автоматические обновления

  *Рекомендуемые таймфреймы:*
  • 15m - внутридневная торговля
  • 1h - краткосрочная торговля
  • 4h - среднесрочная торговля
  • 1d - дневная торговля
  • 1w - недельный анализ

  Для вопросов: @your_support
  `;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
  });

  // Команда /quick - быстрый анализ из config.json
  bot.onText(/\/quick/, (msg) => {
    const chatId = msg.chat.id;
    
    // Создаём кнопки из конфига
    const keyboard = {
      inline_keyboard: []
    };
    
    // Берём приоритетные символы из конфига
    const prioritySymbols = config.symbols
      .filter(s => s.priority <= 4)
      .sort((a, b) => a.priority - b.priority);
    
    prioritySymbols.forEach(symbolConfig => {
      const row = [
        { 
          text: `${symbolConfig.emoji} ${symbolConfig.name} 1h`, 
          callback_data: `quick_${symbolConfig.symbol}_1h` 
        },
        { 
          text: `${symbolConfig.emoji} ${symbolConfig.name} 4h`, 
          callback_data: `quick_${symbolConfig.symbol}_4h` 
        },
        { 
          text: `${symbolConfig.emoji} ${symbolConfig.name} 1d`, 
          callback_data: `quick_${symbolConfig.symbol}_1d` 
        }
      ];
      keyboard.inline_keyboard.push(row);
    });
    
    // Добавляем кнопку для всех символов
    keyboard.inline_keyboard.push([
      { text: '📋 Все символы', callback_data: 'quick_all_symbols' }
    ]);
    
    bot.sendMessage(chatId, '⚡ *Быстрый анализ*\n\nВыберите символ и таймфрейм:', {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
  });

  // ============================================================================
  // ПЛАНИРОВАНИЕ ОБНОВЛЕНИЙ
  // ============================================================================

  // Планирование обновлений с учётом config.json и мониторинга пользователей
  // ============================================================================

  // 15 минут - каждые 15 минут
  cron.schedule('*/15 * * * *', async () => {
    console.log('⏰ Проверка 15m...');
    await checkAllMonitoring('15m');
  });

  // 1 час - каждый час
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Проверка 1h...');
    await checkAllMonitoring('1h');
  });

  // 4 часа - каждые 4 часа
  cron.schedule('0 */4 * * *', async () => {
    console.log('⏰ Проверка 4h...');
    await checkAllMonitoring('4h');
  });

  // 1 день - каждый день в 9:00
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Проверка 1d...');
    await checkAllMonitoring('1d');
  });

  // 1 неделя - каждый понедельник в 9:00
  cron.schedule('0 9 * * 1', async () => {
    console.log('⏰ Проверка 1w...');
    await checkAllMonitoring('1w');
  });

  // Функция проверки всех активных мониторингов
  async function checkAllMonitoring(interval) {
    for (const [chatId, settings] of userSettings.entries()) {
      try {
        // Проверяем полный мониторинг
        if (settings.fullMonitoring && settings.fullMonitoring.enabled) {
          const symbols = settings.fullMonitoring.symbols || [];
          const intervals = settings.fullMonitoring.intervals || [];
          
          if (intervals.includes(interval)) {
            for (const symbol of symbols) {
              const symbolConfig = config.symbols.find(s => s.symbol === symbol);
              if (symbolConfig) {
                console.log(`📊 Полный мониторинг: ${symbol} ${interval} для чата ${chatId}`);
                
                const intervalConfig = config.intervals[interval];
                const analysisSettings = {
                  symbol: symbol,
                  interval: interval,
                  barsCount: intervalConfig.barsCount,
                  rowSize: config.settings.rowSize,
                  valueAreaPercent: config.settings.valueAreaPercent
                };
                
                await sendFRVPAnalysis(chatId, analysisSettings, true);
                
                // Задержка между запросами к API
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
          }
        }
        
        // Проверяем мониторинг отдельных символов
        if (settings.symbolMonitoring) {
          for (const [symbol, monitorConfig] of Object.entries(settings.symbolMonitoring)) {
            if (monitorConfig.enabled && monitorConfig.intervals.includes(interval)) {
              console.log(`📊 Мониторинг символа: ${symbol} ${interval} для чата ${chatId}`);
              
              const intervalConfig = config.intervals[interval];
              const analysisSettings = {
                symbol: symbol,
                interval: interval,
                barsCount: intervalConfig.barsCount,
                rowSize: config.settings.rowSize,
                valueAreaPercent: config.settings.valueAreaPercent
              };
              
              await sendFRVPAnalysis(chatId, analysisSettings, true);
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        }
        
        // Проверяем настройки автообновления (старый формат)
        if (settings.autoUpdate && settings.autoInterval === interval) {
          console.log(`📊 Автообновление: ${settings.symbol} ${interval} для чата ${chatId}`);
          
          const intervalConfig = config.intervals[interval];
          await sendFRVPAnalysis(chatId, {
            ...settings,
            barsCount: intervalConfig.barsCount
          }, true);
        }
      } catch (error) {
        console.error(`❌ Ошибка проверки для чата ${chatId}:`, error);
      }
    }
    
    console.log(`✅ Проверка ${interval} завершена`);
  }

  console.log('✅ Автоматический мониторинг настроен для всех таймфреймов');
  console.log('📊 Расписание:');
  console.log('   • 15m - каждые 15 минут');
  console.log('   • 1h - каждый час');
  console.log('   • 4h - каждые 4 часа');
  console.log('   • 1d - каждый день в 9:00');
  console.log('   • 1w - каждый понедельник в 9:00');

  // ============================================================================
  // ОБРАБОТКА ОШИБОК
  // ============================================================================

  bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.message);
    
    if (error.message.includes('404')) {
      console.error('');
      console.error('🔴 ОШИБКА 404: Токен бота неверный!');
      console.error('');
      console.error('Решение:');
      console.error('1. Проверьте токен в файле .env');
      console.error('2. Убедитесь, что токен правильный (без пробелов)');
      console.error('3. Получите новый токен у @BotFather если нужно');
      console.error('');
      console.error('Формат токена: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz');
      console.error('');
      process.exit(1);
    }
    
    if (error.message.includes('409')) {
      console.error('');
      console.error('🔴 ОШИБКА 409: Бот уже запущен в другом месте!');
      console.error('');
      console.error('Решение:');
      console.error('1. Остановите все другие запущенные экземпляры бота');
      console.error('2. Подождите 1-2 минуты');
      console.error('3. Запустите бота снова');
      console.error('');
      process.exit(1);
    }
  });

  bot.on('error', (error) => {
    console.error('❌ Bot error:', error.message);
  });

  // Подтверждение успешного запуска
  bot.getMe().then((botInfo) => {
    console.log('✅ Бот успешно подключен!');
    console.log(`👤 Имя бота: @${botInfo.username}`);
    console.log(`🆔 ID бота: ${botInfo.id}`);
    console.log('');
    console.log('📊 Настройки:');
    console.log(`   Символ: ${CONFIG.SYMBOL}`);
    console.log(`   Таймфрейм: ${CONFIG.INTERVAL}`);
    console.log(`   Частота обновлений: ${CONFIG.UPDATE_FREQUENCY}`);
    console.log('');
    console.log('💡 Откройте Telegram и отправьте боту /start');
    console.log('');
  }).catch((error) => {
    console.error('❌ Не удалось подключиться к боту:', error.message);
    console.error('');
    console.error('Проверьте:');
    console.error('1. Токен в файле .env правильный');
    console.error('2. Интернет соединение работает');
    console.error('3. Telegram API доступен');
    console.error('');
    process.exit(1);
  });

  process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
  });

  process.on('SIGINT', () => {
    console.log('');
    console.log('🛑 Остановка бота...');
    bot.stopPolling();
    process.exit(0);
  });