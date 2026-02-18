// systems/hollow-knight/hkrg.js

// ============================================
// КЛАССЫ ЛИСТОВ (ОБЪЯВЛЯЕМ ПЕРЕД ИСПОЛЬЗОВАНИЕМ!)
// ============================================

class HKRPGActorSheet extends ActorSheet {
  /**
   * КЛЮЧЕВОЙ МОМЕНТ: Динамический выбор шаблона
   */
  get template() {
    const type = this.actor.type;
    return `systems/hollow-knight/templates/actor/${type}-sheet.html`;
  }

  getData() {
    const data = super.getData();
    data.dtypes = ["String", "Number", "Boolean"];
    const insight = data.data.system.characteristics.insight.value || 0;
    data.data.system.techniques.slots.max = Math.floor(insight);
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('.characteristic input').click(ev => {
      ev.preventDefault();
      const input = ev.currentTarget;
      const key = input.name.split('.')[3];
      const value = parseFloat(input.value) || 0;
      const label = game.i18n.localize(`HKRPG.Actor.Characteristics.${key}`);
      hkrpgRoll({ characteristic: value, label: `Проверка: ${label}` });
    });

    html.find('.pool input').click(ev => {
      ev.preventDefault();
      const input = ev.currentTarget;
      const key = input.name.split('.')[3];
      const value = parseInt(input.value) || 0;
      const label = game.i18n.localize(`HKRPG.Actor.Pools.${key}`);
      ui.notifications.info(`${label}: ${value}`);
    });

    html.find('.item-create').click(ev => {
      ev.preventDefault();
      const type = ev.currentTarget.dataset.type;
      const name = `Новый ${type}`;
      this.actor.createEmbeddedDocuments("Item", [{ type: type, name: name }]);
    });

    html.find('.item-edit').click(ev => {
      ev.preventDefault();
      const li = ev.currentTarget.closest('.item');
      const item = this.actor.items.get(li.dataset.itemId);
      if (item) item.sheet.render(true);
    });

    html.find('.item-delete').click(ev => {
      ev.preventDefault();
      const li = ev.currentTarget.closest('.item');
      this.actor.deleteEmbeddedDocuments("Item", [li.dataset.itemId]);
    });

    html.find('input[type="number"]').wheel(ev => {
      ev.preventDefault();
      const input = ev.currentTarget;
      const step = ev.deltaY > 0 ? -1 : 1;
      const min = parseFloat(input.min) || -Infinity;
      const max = parseFloat(input.max) || Infinity;
      const newValue = Math.min(Math.max(parseFloat(input.value) + step, min), max);
      input.value = newValue;
      input.dispatchEvent(new Event('change'));
    });
  }
}

class HKRPGItemSheet extends ItemSheet {
  get template() {
    const type = this.item.type;
    return `systems/hollow-knight/templates/item/${type}-sheet.html`;
  }

  getData() {
    return super.getData();
  }

  activateListeners(html) {
    super.activateListeners(html);
  }
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ СИСТЕМЫ
// ============================================

Hooks.once("init", function () {
  console.log("HKRPG System Initialized for Foundry V13");

  CONFIG.HKRPG = {
    rollFormula: "d6cs>=5",
    initiativeFormula: "d6",
    characteristics: ["might", "grace", "shell", "insight"],
    pools: ["hearts", "soul", "stamina"]
  };

  // Регистрация листов — ТЕПЕРЬ КЛАССЫ УЖЕ ОБЪЯВЛЕНЫ
  Actors.registerSheet("hollow-knight", HKRPGActorSheet, {
    types: ["character", "npc", "creature"],
    makeDefault: true,
    label: "HKRPG Sheet"
  });

  Items.registerSheet("hollow-knight", HKRPGItemSheet, {
    makeDefault: true,
    label: "HKRPG Item Sheet"
  });
});

Hooks.once("ready", function () {
  window.hkrpgRoll = hkrpgRoll;
  window.hkrpgDamage = hkrpgDamage;
  window.hkrpgInitiative = hkrpgInitiative;
  console.log("HKRPG System Ready");
});

// ============================================
// МЕХАНИКА БРОСКОВ
// ============================================

async function hkrpgRoll(data) {
  const { characteristic, skillRank = 0, rerolls = 0, label = "Проверка" } = data;
  
  const baseDice = Math.floor(characteristic);
  const extraRerolls = (characteristic % 1) >= 0.5 ? 1 : 0;
  const totalDice = baseDice + skillRank;

  if (totalDice <= 0) {
    ui.notifications.warn(game.i18n.localize("HKRPG.Errors.NoDice"));
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

async function hkrpgInitiative(combatant) {
  const grace = combatant.actor?.system.characteristics.grace.value || 0;
  if (grace <= 0) return 0;
  const roll = new Roll(`${grace}d6`);
  await roll.evaluate({ async: true });
  return roll.total;
}

async function hkrpgDamage(data) {
  const { damage, absorption = 0, pu = 0 } = data;
  let finalDmg = damage;
  if (pu > 0) finalDmg = Math.max(1, finalDmg - pu);
  if (absorption > 0) {
    const absValue = 1 + Math.floor(finalDmg / absorption);
    finalDmg = Math.max(0, finalDmg - absValue);
  }
  ui.notifications.notify(`${game.i18n.localize("HKRPG.Chat.Damage")}: ${finalDmg}`);
  return finalDmg;
}

// ============================================
// БОЕВАЯ ЛОГИКА
// ============================================

Hooks.on("createCombatant", (combat, combatant) => {
  if (["character", "npc", "creature"].includes(combatant.actor?.type)) {
    hkrpgInitiative(combatant).then(initValue => {
      combatant.update({ initiative: initValue });
    });
  }
});

Hooks.on("updateCombat", (combat, changed) => {
  if (changed.turn === 0 && combat.turns[0]?.actor) {
    const actor = combat.turns[0].actor;
    if (["character", "npc", "creature"].includes(actor.type)) {
      const maxStamina = actor.system.pools.stamina.max || 3;
      actor.update({ "system.pools.stamina.value": maxStamina });
      ui.notifications.notify(`${actor.name}: ${game.i18n.localize("HKRPG.Notifications.StaminaRestored")}`);
    }
  }
});

Hooks.on("preUpdateActor", (actor, updateData, options, userId) => {
  if (userId !== game.user.id) return;
  if (updateData["system.pools.hearts.value"] !== undefined) {
    const newHearts = updateData["system.pools.hearts.value"];
    if (newHearts <= 0 && actor.type === "character") {
      ui.notifications.warn(`${actor.name} достиг Врат Смерти!`);
    }
  }
});

// ============================================
// ЭКСПОРТ ДЛЯ МОДУЛЬНОСТИ (ДОБАВЛЕНО!)
// ============================================
export { HKRPGActorSheet, HKRPGItemSheet, hkrpgRoll, hkrpgDamage, hkrpgInitiative };
