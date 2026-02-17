
Hooks.once("init", function() {
  console.log("HKRPG System Initialized");
  game.system.documentTypes = {
    Actor: ["character", "npc", "creature"],
    Item: ["weapon", "armor", "charm", "spell"]
  };
});

// Функция броска по правилам HKRPG
async function hkrpgRoll(characteristic, modifier = 0, rerolls = 0) {
  const diceCount = characteristic + modifier;
  if (diceCount <= 0) return;

  const roll = new Roll(`${diceCount}d6`);
  await roll.evaluate({ async: true });

  // Подсчет успехов (5 и 6)
  let successes = 0;
  roll.terms[0].results.forEach(r => {
    if (r.result >= 5) successes++;
  });

  // Логика повторных бросков (если есть черты типа 0.5 характеристики)
  // Упрощенно для старта:
  if (rerolls > 0) {
    // Тут нужна логика замены кубиков, пока базовая
  }

  const chatData = {
    user: game.user.id,
    speaker: ChatMessage.getSpeaker(),
    content: `
      <div class="hkrpg-roll">
        <h3>Проверка Характеристики</h3>
        <p>Кубов: ${diceCount} | Успехов: <strong>${successes}</strong></p>
        <div class="dice-results">${roll.result}</div>
      </div>
    `,
    roll: roll
  };

  ChatMessage.create(chatData);
}

// Регистрация макроса для теста
globalThis.hkrpgRoll = hkrpgRoll;
