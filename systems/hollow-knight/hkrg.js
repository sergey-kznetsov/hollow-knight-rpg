Hooks.once("init", function () {
  console.log("HKRPG System Initialized for V13");

  CONFIG.HKRPG = {
    rollFormula: "d6cs>=5",
    characteristics: ["might", "grace", "shell", "insight"]
  };

  // Регистрация листов
  Actors.registerSheet("hollow-knight", HKRPGActorSheet, {
    types: ["character"],
    makeDefault: true,
    label: "HKRPG Character Sheet"
  });

  Items.registerSheet("hollow-knight", HKRPGItemSheet, {
    makeDefault: true,
    label: "HKRPG Item Sheet"
  });
});

Hooks.once("ready", function () {
  window.hkrpgRoll = hkrpgRoll;
});

// --- Классы Листов ---
class HKRPGActorSheet extends ActorSheet {
  getData() {
    const data = super.getData();
    data.dtypes = ["String", "Number", "Boolean"];
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);
    // Бросок характеристики по клику
    html.find('.characteristic input').click(ev => {
      const input = ev.currentTarget;
      const characteristic = input.closest('.characteristic').querySelector('label').innerText;
      const value = parseInt(input.value) || 0;
      hkrpgRoll({ characteristic: value, label: `Проверка: ${characteristic}` });
    });
  }
}

class HKRPGItemSheet extends ItemSheet {
  getData() {
    const data = super.getData();
    return data;
  }
}

// --- Боевая Логика ---

// Инициатива по Грации (сумма кубиков, стр. 116)
Hooks.on("createCombatant", (combat, combatant, options) => {
  if (combatant.actor?.type === "character") {
    const grace = combatant.actor.system.characteristics.grace.value || 0;
    // Формула: количество кубиков равно Грации, считаем сумму
    combatant.update({ initiative: new Roll(`${grace}d6`).evaluate().total });
  }
});

// Сброс Выносливости в начале хода (стр. 9)
Hooks.on("updateCombat", (combat, changed) => {
  if (changed.turn === 0 && combat.turns[0]?.actor) {
    const actor = combat.turns[0].actor;
    if (actor.type === "character") {
      const maxStamina = actor.system.pools.stamina.max || 3;
      actor.update({ "system.pools.stamina.value": maxStamina });
      ui.notifications.notify(`Ход ${actor.name}: Выносливость восстановлена.`);
    }
  }
});

// --- Функция Броска ---
async function hkrpgRoll(data) {
  const { characteristic, skillRank = 0, rerolls = 0, label = "Проверка" } = data;
  const baseDice = Math.floor(characteristic);
  const totalDice = baseDice + skillRank;

  if (totalDice <= 0) {
    ui.notifications.warn("Недостаточно кубиков для броска!");
    return;
  }

  const roll = new Roll(`${totalDice}${CONFIG.HKRPG.rollFormula}`);
  await roll.evaluate({ async: true });
  const successes = roll.total;

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
