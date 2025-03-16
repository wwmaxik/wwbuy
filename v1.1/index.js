const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mineflayer = require('mineflayer');
const axios = require('axios');
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Исходный список покупок
let purchaseList = [
  {
    name: "diamond",
    minPricePerUnit: 7500
  }
];

let bot = null;
let bot_balance = 0;
let bot_session_income = 0;
let bot_items_count = 0;
let botStartTime = null;
const ah_update_delay = 7 / 20 * 1000; // задержка для обновления аукциона

const wwbuy_version = "1.1";

// Функция создания и настройки бота
function createBot(config, password, anarchy) {
  bot = mineflayer.createBot(config);

  bot.on('spawn', () => {
    // Если бот не в spawn-локации, выполняем необходимые команды
    if (bot.game.dimension !== "spawn") {
      bot.chat('/l ' + password);
      bot.chat('/an' + anarchy);
    }
    bot.chat('/ah');
    bot.chat('/bal');
    bot.chat('/afk');
  });

  // Добавленные обработчики статистики
  bot.on('health', () => updateBotStats());
  bot.on('food', () => updateBotStats());
  bot.on('experience', () => updateBotStats());

  function updateBotStats() {
    io.emit('botStats', {
      health: bot.health,
      food: bot.food,
      xp: bot.experience?.level || 0,
      saturation: bot.foodSaturation,
      balance: bot_balance,
      session_income: bot_session_income,
      items_count: bot_items_count
    });
  }

  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString().trim();
    console.log(msg);

    io.emit('botMessage', msg);

    // Регулярное выражение для поиска суммы в операциях
    const amountMatch = msg.match(/(?:\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)|\b(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s?\$)/);
    const amount = amountMatch ? (amountMatch[1] || amountMatch[2]).replace(/,/g, '') : null;

    // Регулярное выражение для поиска баланса
    const balanceMatch = msg.match(/\[\$\] Ваш баланс:\s?\$([\d,]+\.\d{2})/);
    if (balanceMatch) {
        const balance = parseFloat(balanceMatch[1].replace(/,/g, ''));
        //console.log(`Обновленный баланс: $${balance}`);
        bot_balance = balance; // Если у тебя есть переменная для баланса
        updateBotStats();
    }

    // Определяем тип операции (покупка или продажа)
    let operationType = null;
    if (amount) {
        if (/купили|покупка|купить/.test(msg)) {
            operationType = 'покупка';
        } else if (/продали|продажа|авто-продажа/.test(msg)) {
            operationType = 'продажа';
        }
    }

    // Если сумма найдена и тип операции определен
    if (amount && operationType) {
        const amountValue = parseFloat(amount);

        console.log(`Тип операции: ${operationType}, Сумма: $${amountValue}`);

        if (operationType === 'покупка') {
            bot_session_income -= amountValue;
            bot_balance -= amountValue;
            bot_items_count += 1;
        } else if (operationType === 'продажа') {
            bot_session_income += amountValue;
            bot_balance += amountValue;
        }
        updateBotStats();
    } else {
        //console.log('Сумма или тип операции не найдены в сообщении.');
    }
  });

  bot.on('windowOpen', (window) => {
    checkAuctionPage(window);
    updateBotStats();

    //console.log(bot.teams)

    if (bot.players) {
      const players = [];
          
      for (const player of Object.values(bot.players)) {
          players.push( player.username );
      }
      io.emit('teamsUpdate', players);
    }
  });

  bot.on('error', err => console.log(`Ошибка: ${err}`));
  bot.on('kicked', reason => console.log(`Бот был кикнут: ${reason}`));
}

// Функция для обновления аукциона (клик по 49 слоту)
async function refreshAuction(window) {
  try {
    await bot.clickWindow(49, 0, 0);
  } catch (error) {
    //console.log(error);
  }
}

// Функция для обработки страницы аукциона
function checkAuctionPage(window) {
  let auctionItems = [];

  window.slots.forEach((slot, index) => {
    if (index === 45) return; // конец списка, далее кнопки управления

    if (!slot || !slot.nbt || !slot.nbt.value || !slot.nbt.value.display || !slot.nbt.value.display.value) return;

    const displayData = slot.nbt.value.display.value;
    let itemID = slot.name || "Без ID";
    let itemName = slot.displayName || "Без имени";
    let itemLore = "Нет описания";
    let itemPrice = null;
    let itemCount = slot.count;
    let itemPricePerUnit = "Не определена";

    // Обработка имени (Name)
    if (displayData.Name) {
      try {
        const nameData = JSON.parse(displayData.Name.value);
        if (nameData.extra) {
          itemName = nameData.extra.map(part => part.text).join("");
        } else {
          itemName = nameData.text || "Без имени";
        }
      } catch (error) {
        itemName = displayData.Name.value;
      }
    }

    // Обработка лора
    if (displayData.Lore) {
      try {
        const loreData = displayData.Lore.value.value;
        itemLore = "";
        loreData.forEach(loreD => {
          try {
            const jsonLore = JSON.parse(loreD);
            if (jsonLore.extra) {
              jsonLore.extra.forEach(part => {
                itemLore += part.text || "";
              });
            } else if (jsonLore.text) {
              itemLore += jsonLore.text || "";
            }
            itemLore += "\n";
          } catch (error) {
            //console.error("Ошибка при парсинге строки лора:", error);
          }
        });
        itemLore = itemLore.trim();
        const priceMatch = itemLore.match(/\$\s*Цена:\s*\$\s*([\d,]+)/);
        if (priceMatch && priceMatch[1]) {
          itemPrice = parseInt(priceMatch[1].replace(/,/g, ''), 10);
          if (itemCount > 0) {
            itemPricePerUnit = itemPrice / itemCount;
          }
        } else {
          itemPrice = "Нет цены";
          itemPricePerUnit = "Не определена";
        }
      } catch (error) {
        //console.error("Ошибка при обработке лора:", error);
        itemLore = "Нет описания";
      }
    }

    // Парсинг завариваний
    let enchantments = {};
    const parseEnchantments = (nbtTag) => {
      try {
        const enchList = nbtTag.value.value;
        enchList.forEach(ench => {
          const id = ench.id.value.split(':')[1];
          const level = ench.lvl.value;
          enchantments[id] = level;
        });
      } catch (error) {
        //console.error('Ошибка парсинга зачарований:', error);
      }
    };

    if (slot.nbt.value.Enchantments) parseEnchantments(slot.nbt.value.Enchantments);
    else if (slot.nbt.value.ench) parseEnchantments(slot.nbt.value.ench);
    else if (slot.nbt.value.StoredEnchantments) parseEnchantments(slot.nbt.value.StoredEnchantments);

    // Добавляем данные о лоте в массив для передачи на клиент
    auctionItems.push({
      slot: index,
      id: itemID,
      name: itemName,
      count: itemCount,
      price: itemPrice,
      pricePerUnit: itemPricePerUnit,
      enchantments: enchantments,
      lore: itemLore
    });

    // Проверка условий покупки
    purchaseList.forEach(purchaseItem => {
      const matchesId = purchaseItem.name === itemID;
      const matchesCustomName = !purchaseItem.customName || itemName.includes(purchaseItem.customName);
      const matchesMinPricePerUnit = itemPricePerUnit !== "Не определена" && itemPricePerUnit <= purchaseItem.minPricePerUnit;

      let matchesEnchants = true;
      if (purchaseItem.enchants) {
        for (const [enchantId, minLevel] of Object.entries(purchaseItem.enchants)) {
          if (!enchantments[enchantId] || enchantments[enchantId] < minLevel) {
            matchesEnchants = false;
            break;
          }
        }
      }

      if (matchesId && matchesCustomName && matchesMinPricePerUnit && matchesEnchants) {
        bot.clickWindow(index, 0, 1)
          .then(() => {
            //console.log(`Предмет ${itemName} успешно куплен!`);
          })
          .catch((err) => {
            //console.error(`Ошибка при покупке предмета: ${err}`);
          });
      }
    });
  });

  // Отправляем данные аукциона на клиент
  io.emit('auctionData', auctionItems);

  // Обновляем аукцион с задержкой
  setTimeout(() => {
    refreshAuction(window);
  }, ah_update_delay);
}

// Статические файлы из папки "public"
app.get('/', async (req, res) => {
  try {
    // Делаем запрос на внешний сервер для получения HTML
    const response = await axios.get(`https://raw.githubusercontent.com/wwmaxik/wwbuy/refs/heads/main/v${wwbuy_version}/index.html`);
    
    // Отправляем полученный HTML на клиент
    res.send(response.data);
  } catch (error) {
    res.status(500).send('Ошибка при загрузке HTML');
  }
});


// Статические файлы из папки "public"
app.use(express.static('public'));
app.use(express.json());

// Эндпоинт для обновления списка покупок (принимает JSON с новым списком)
app.post('/updatePurchaseList', (req, res) => {
  purchaseList = req.body.purchaseList;
  //console.log('Обновлён список покупок:', purchaseList);
  res.sendStatus(200);
});

// Эндпоинт для запуска бота
app.post('/startBot', (req, res) => {
  if (!bot) {
    const { username, password, host, port, version, anarchy } = req.body;

    const botConfig = {
      host: host,
      port: parseInt(port, 10),
      username: username,
      version: version
    };

    createBot(botConfig, password, anarchy);
    botStartTime = Date.now();
    setInterval(() => {
      if (botStartTime) {
        const uptime = Date.now() - botStartTime;
        io.emit('botUptime', uptime);
      }
    }, 1000);
    res.json({ status: 'Бот запущен' });
  } else {
    res.json({ status: 'Бот уже запущен' });
  }
});

// Обработка сообщений от клиента через WebSocket
io.on('connection', (socket) => {
  //console.log('Клиент подключился');

  // Обработчик сообщения от клиента
  socket.on('sendMessage', (message) => {
    //console.log(`Сообщение от клиента: ${message}`);
    if (bot) {
      bot.chat(message); // Отправка сообщения боту
    }
  });

  socket.on('disconnect', () => {
    //console.log('Клиент отключился');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
