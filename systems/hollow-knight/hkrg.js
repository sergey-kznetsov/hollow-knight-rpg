Hooks.once("init", function () {
  console.log("HKRPG System Initialized for V13");
  
  // Регистрация типов документов
  CONFIG.HKRPG = {
    rollFormula: "d6cs>=5", // Успех на 5-6
    characteristics: ["might", "grace", "shell", "insight"]
  };
});

// Глобальная функция броска для макросов и листов
async function hkrpgRoll(data) {
  const { characteristic, skillRank = 0, rerolls = 0, label = "Проверка" } = data;
  
  // Обработка дробных характеристик (0.5 = 1 перекат)
  const baseDice = Math.floor(characteristic);
  const extraRerolls = characteristic % 1 >= 0.5 ? 1 : 0;
  const totalDice = baseDice + skillRank;
  const totalRerolls = rerolls + extraRerolls;

  if (totalDice <= 0) {
    ui.notifications.warn("Недостаточно кубиков для броска!");
    return;
  }

  const roll = new Roll(`${totalDice}${CONFIG.HKRPG.rollFormula}`);
  await roll.evaluate({ async: true });

  // Подсчет успехов
  const successes = roll.total; // В формуле cs>=5 total уже считает успехи
  
  // Логика перекатов (упрощенная для старта)
  // В Foundry d6cs>=5 возвращает количество успехов сразу. 
  // Для перекатов нужно кастомное решение или модификатор формулы.
  // Для V13 используем стандартный ролл пока что.

  const chatData = {
    user: game.user.id,
    speaker: ChatMessage.getSpeaker(),
    content: `
      <div class="hkrpg-roll card">
        <h3>${label}</h3>
        <p>Кубов: ${totalDice} | Успехов: <strong>${successes}</strong></p>
        <div class="dice-tooltip">${roll.result}</div>
      </div>
    `,
    roll: roll
  };

  ChatMessage.create(chatData);
  return roll;
}

// Хук готовности
Hooks.once("ready", function () {
  // Делаем функцию доступной в консоли и макросах
  window.hkrpgRoll = hkrpgRoll;
  
  // Пример регистрации листа (заглушка)
  Actors.registerSheet("hollow-knight", HKRPGActorSheet, {
    types: ["character"],
    makeDefault: true
  });
});

// Заглушка класса листа (нужен отдельный файл, но для каркаса тут)
class HKRPGActorSheet extends ActorSheet {
  getData() {
    const data = super.getData();
    return data;
  }
}
