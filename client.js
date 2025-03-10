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
const ah_update_delay = 10 / 20 * 1000; // задержка для обновления аукциона

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
      saturation: bot.foodSaturation
    });
  }

  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString().trim();
    console.log(msg);
    io.emit('botMessage', msg);
  });

  bot.on('windowOpen', (window) => {
    checkAuctionPage(window);

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

    // Парсинг зачарований
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
    const response = await axios.get('https://raw.githubusercontent.com/wwmaxik/wwbuy_icons/refs/heads/main/index.html');
    
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