// systems/hollow-knight/hkrg.js

Hooks.once("init", function () {
  console.log("HKRPG System Initialized for Foundry V13");

  // --- Конфигурация системы ---
  CONFIG.HKRPG = {
    rollFormula: "d6cs>=5", // Формула успеха: 5 и 6
    initiativeFormula: "d6", // Формула инициативы (бросается количество кубов равное Грации)
    characteristics: ["might", "grace", "shell", "insight"],
    pools: ["hearts", "soul", "stamina"]
  };

  // --- Регистрация листов Актеров ---
  Actors.registerSheet("hollow-knight", HKRPGActorSheet, {
    types: ["character", "npc", "creature"],
    makeDefault: true,
    label: "HKRPG Character Sheet"
  });

  // --- Регистрация листов Предметов ---
  Items.registerSheet("hollow-knight", HKRPGItemSheet, {
    makeDefault: true,
    label: "HKRPG Item Sheet"
  });

  // --- Настройка инициативы для компедиумов (если нужно) ---
  // CONFIG.Combat.initiative = {
  //   formula: "1d6 + @characteristics.grace.value", // Пример, но мы переопределим в хуке
  // };
});

Hooks.once("ready", function () {
  // Делаем функции доступными в консоли и макросах
  window.hkrpgRoll = hkrpgRoll;
  window.hkrpgDamage = hkrpgDamage;
  window.hkrpgInitiative = hkrpgInitiative;
  
  console.log("HKRPG System Ready");
});

// --- Классы Листов ---

class HKRPGActorSheet extends ActorSheet {
  getData() {
    const data = super.getData();
    data.dtypes = ["String", "Number", "Boolean"];
    
    // Пример вычисляемых данных (можно расширить)
    // Ячейки Техник = Проницательность (округленная вниз)
    const insight = data.data.system.characteristics.insight.value || 0;
    data.data.system.techniques.slots.max = Math.floor(insight);
    
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Бросок Характеристики по клику на поле ввода
    html.find('.characteristic input').click(ev => {
      ev.preventDefault();
      const input = ev.currentTarget;
      const key = input.name.split('.')[3]; // Извлекаем ключ (might, grace...)
      const value = parseFloat(input.value) || 0;
      const label = game.i18n.localize(`HKRPG.Actor.Characteristics.${key}`);
      hkrpgRoll({ characteristic: value, label: `Проверка: ${label}` });
    });

    // Бросок Запаса (Сердца, Души, Выносливость)
    html.find('.pool input').click(ev => {
      ev.preventDefault();
      const input = ev.currentTarget;
      // Логика для запасов может отличаться, пока заглушка
      ui.notifications.info("Настройте бросок для запасов в макросах");
    });

    // Создание предмета
    html.find('.item-create').click(ev => {
      ev.preventDefault();
      const type = ev.currentTarget.dataset.type;
      this.actor.createEmbeddedDocuments("Item", [{ type: type, name: `Новый ${type}` }]);
    });

    // Редактирование предмета
    html.find('.item-edit').click(ev => {
      ev.preventDefault();
      const li = ev.currentTarget.closest('.item');
      const item = this.actor.items.get(li.dataset.itemId);
      item.sheet.render(true);
    });

    // Удаление предмета
    html.find('.item-delete').click(ev => {
      ev.preventDefault();
      const li = ev.currentTarget.closest('.item');
      this.actor.deleteEmbeddedDocuments("Item", [li.dataset.itemId]);
    });
  }
}

class HKRPGItemSheet extends ItemSheet {
  getData() {
    const data = super.getData();
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);
    // Можно добавить кнопки для броска урона предмета и т.д.
  }
}

// --- Механика Бросков ---

/**
 * Основной функция броска проверки Характеристики
 * @param {Object} data - { characteristic: number, skillRank: number, rerolls: number, label: string }
 */
async function hkrpgRoll(data) {
  const { characteristic, skillRank = 0, rerolls = 0, label = "Проверка" } = data;
  
  // Обработка дробных характеристик (0.5 = 1 перекат)
  const baseDice = Math.floor(characteristic);
  const extraRerolls = (characteristic % 1) >= 0.5 ? 1 : 0;
  const totalDice = baseDice + skillRank;
  const totalRerolls = rerolls + extraRerolls;

  if (totalDice <= 0) {
    ui.notifications.warn(game.i18n.localize("HKRPG.Errors.NoDice"));
    return;
  }

  // Создаем ролл
  const roll = new Roll(`${totalDice}${CONFIG.HKRPG.rollFormula}`);
  await roll.evaluate({ async: true });

  // Подсчет успехов (в формуле cs>=5 total уже считает успехи)
  const successes = roll.total;
  
  // Формирование чата
  const chatData = {
    user: game.user.id,
    speaker: ChatMessage.getSpeaker(),
    content: `
      <div class="hkrpg-roll card">
        <h3>${label}</h3>
        <p>${game.i18n.localize("HKRPG.Chat.Dice")}: ${totalDice} | ${game.i18n.localize("HKRPG.Chat.Successes")}: <strong>${successes}</strong></p>
        <div class="dice-tooltip">${roll.result}</div>
      </div>
    `,
    roll: roll,
    flavor: label
  };

  ChatMessage.create(chatData);
  return roll;
}

/**
 * Функция броска Инициативы (Сумма кубов Грации)
 * @param {Combatant} combatant 
 */
async function hkrpgInitiative(combatant) {
  const grace = combatant.actor?.system.characteristics.grace.value || 0;
  if (grace <= 0) return 0;

  const roll = new Roll(`${grace}d6`);
  await roll.evaluate({ async: true });
  
  // Инициатива в HKRPG - это сумма выпавших значений, а не успехи
  return roll.total;
}

/**
 * Базовая функция расчета урона (заглушка для расширения)
 */
async function hkrpgDamage(data) {
  const { damage, absorption = 0, pu = 0 } = data;
  let finalDmg = damage;
  
  // Понижение Урона (ПУ)
  if (pu > 0) finalDmg = Math.max(1, finalDmg - pu);
  
  // Поглощение (формула: 1 + dmg/abs) - упрощенно
  if (absorption > 0) {
    const absValue = 1 + Math.floor(finalDmg / absorption);
    finalDmg = Math.max(0, finalDmg - absValue);
  }

  ui.notifications.notify(`${game.i18n.localize("HKRPG.Chat.Damage")}: ${finalDmg}`);
  return finalDmg;
}

// --- Боевая Логика ---

// 1. Инициатива при создании комбатанта
Hooks.on("createCombatant", (combat, combatant, options) => {
  if (combatant.actor?.type === "character" || combatant.actor?.type === "npc") {
    // Используем нашу функцию инициативы
    hkrpgInitiative(combatant).then(initValue => {
      combatant.update({ initiative: initValue });
    });
  }
});

// 2. Сброс Выносливости в начале хода
Hooks.on("updateCombat", (combat, changed) => {
  // Если изменился ход и это новый ход (turn === 0 означает начало нового раунда или первый ход)
  // В Foundry turn === 0 срабатывает при переходе к первому участнику в раунде
  if (changed.turn === 0 && combat.turns[0]?.actor) {
    const actor = combat.turns[0].actor;
    
    // Сброс Выносливости для персонажей и НИПов
    if (actor.type === "character" || actor.type === "npc") {
      const maxStamina = actor.system.pools.stamina.max || 3;
      actor.update({ "system.pools.stamina.value": maxStamina });
      
      // Сброс Дисбаланса (опционально, по правилам часто сбрасывается 1 за ход, но полный сброс в начале хода тоже вариант)
      // actor.update({ "system.combat.imbalance.value": 0 }); 
      
      ui.notifications.notify(`${actor.name}: ${game.i18n.localize("HKRPG.Notifications.StaminaRestored")}`);
    }
  }
});

// 3. Обработка смерти (Врата Смерти)
Hooks.on("preUpdateActor", (actor, updateData, options, userId) => {
  if (userId !== game.user.id) return;
  
  // Проверка на падение Сердец до 0
  if (updateData["system.pools.hearts.value"] !== undefined) {
    const newHearts = updateData["system.pools.hearts.value"];
    if (newHearts <= 0 && actor.type === "character") {
      // Здесь можно добавить диалог "Врата Смерти?"
      // Пока просто уведомление
      ui.notifications.warn(`${actor.name} достиг Врат Смерти!`);
    }
  }
});
