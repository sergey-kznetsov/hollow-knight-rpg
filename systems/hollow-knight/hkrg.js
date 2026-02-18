// systems/hollow-knight/hkrg.js
// Foundry VTT v13 — HKRPG core logic (RU)

// ----------------------------
// Small utilities
// ----------------------------
const SYS_ID = "hollow-knight";

function i18n(key, data) {
  return game.i18n.format(key, data ?? {});
}

function warnChat(actor, titleKey, messageKey, data = {}) {
  const title = i18n(titleKey, data);
  const msg = i18n(messageKey, data);
  ui.notifications.warn(`${actor?.name ?? ""}: ${title} — ${msg}`);

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="hkrpg chat-warning">
        <h3>${title}</h3>
        <p>${msg}</p>
      </div>
    `
  });
}

function infoChat(actor, title, html) {
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="hkrpg chat-info">
        <h3>${title}</h3>
        ${html ?? ""}
      </div>
    `
  });
}

function getActorFromControlledToken() {
  const token = canvas?.tokens?.controlled?.[0];
  return token?.actor ?? null;
}

function clampInt(n, min, max) {
  n = parseInt(n ?? 0, 10);
  if (Number.isNaN(n)) n = 0;
  return Math.max(min, Math.min(max, n));
}

function getStamina(actor) {
  const value = actor?.system?.pools?.stamina?.value ?? 0;
  const max = actor?.system?.pools?.stamina?.max ?? 0;
  return { value, max };
}

async function setStamina(actor, value) {
  return actor.update({ "system.pools.stamina.value": value });
}

// Flags: per-turn stamina tax tracking
function getTurnTax(actor) {
  return actor.getFlag(SYS_ID, "turnTax") ?? 0;
}
async function setTurnTax(actor, n) {
  return actor.setFlag(SYS_ID, "turnTax", n);
}
async function resetTurnTax(actor) {
  return actor.unsetFlag(SYS_ID, "turnTax");
}

// ----------------------------
// Rolls (core dice system: d6, 5-6 = success)
// ----------------------------
async function rollSuccessPool({ dice, label = "Бросок" }) {
  dice = clampInt(dice, 0, 200);
  if (dice <= 0) return null;

  const roll = new Roll(`${dice}d6cs>=5`);
  await roll.evaluate({ async: true });

  // In Foundry, roll.total will be number of successes for cs>=5
  const successes = roll.total ?? 0;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `
      <div class="hkrpg chat-roll">
        <h3>${label}</h3>
        <p><b>${i18n("HKRPG.Chat.Dice")}:</b> ${dice}</p>
        <p><b>${i18n("HKRPG.Chat.Successes")}:</b> ${successes}</p>
        <details>
          <summary>${i18n("HKRPG.Chat.Roll")}</summary>
          <div>${roll.result}</div>
        </details>
      </div>
    `,
    roll
  });

  return { roll, successes, dice };
}

// Initiative in the book: roll a number of d6 equal to Grace, sum pips.
// (Not a success pool.)
async function rollInitiativeForCombatant(combatant) {
  const actor = combatant?.actor;
  const grace = actor?.system?.characteristics?.grace?.value ?? 0;
  const dice = Math.floor(grace);

  if (!dice || dice <= 0) return 0;

  const roll = new Roll(`${dice}d6`);
  await roll.evaluate({ async: true });

  return roll.total ?? 0;
}

// ----------------------------
// Combat turn handling
// - Stamina restores at start of the actor's turn
// - Stamina tax resets at end of the actor's turn
// ----------------------------
Hooks.once("init", () => {
  console.log("HKRPG | init (Foundry v13)");

  CONFIG.HKRPG = {
    characteristics: ["might", "grace", "shell", "insight"],
    pools: ["hearts", "soul", "stamina", "satiety"]
  };

  // Keep your existing sheets registration (minimal changes)
  class HKRPGActorSheet extends ActorSheet {
    get template() {
      const type = this.actor.type;
      return `systems/hollow-knight/templates/actor/${type}-sheet.html`;
    }

    async getData(options = {}) {
      const data = await super.getData(options);

      // v13-friendly: actor.system is already the system data
      const insight = this.actor.system?.characteristics?.insight?.value ?? 0;
      // Slots = floor(insight)
      // We write into data for template usage, but do not force-update actor here.
      foundry.utils.setProperty(data, "system.techniques.slots.max", Math.floor(insight));

      return data;
    }

    activateListeners(html) {
      super.activateListeners(html);

      // Click on characteristic inputs = roll check
      html.find(".characteristic input").on("click", async (ev) => {
        ev.preventDefault();
        const input = ev.currentTarget;
        const path = input.name; // e.g. system.characteristics.might.value
        const key = path?.split(".")?.[2]; // might/grace/shell/insight
        const value = parseFloat(input.value) || 0;
        const label = game.i18n.localize(`HKRPG.Actor.Characteristics.${key}`);
        await hkrpg.rollCheck({ characteristic: value, label: `Проверка: ${label}` });
      });

      // Items create/edit/delete (as you had)
      html.find(".item-create").on("click", (ev) => {
        ev.preventDefault();
        const type = ev.currentTarget.dataset.type;
        const name = `Новый ${type}`;
        this.actor.createEmbeddedDocuments("Item", [{ type, name }]);
      });

      html.find(".item-edit").on("click", (ev) => {
        ev.preventDefault();
        const li = ev.currentTarget.closest(".item");
        const item = this.actor.items.get(li.dataset.itemId);
        item?.sheet?.render(true);
      });

      html.find(".item-delete").on("click", (ev) => {
        ev.preventDefault();
        const li = ev.currentTarget.closest(".item");
        this.actor.deleteEmbeddedDocuments("Item", [li.dataset.itemId]);
      });
    }
  }

  class HKRPGItemSheet extends ItemSheet {
    get template() {
      const type = this.item.type;
      return `systems/hollow-knight/templates/item/${type}-sheet.html`;
    }
  }

  Actors.registerSheet(SYS_ID, HKRPGActorSheet, {
    types: ["character", "npc", "creature"],
    makeDefault: true,
    label: "HKRPG Sheet"
  });

  Items.registerSheet(SYS_ID, HKRPGItemSheet, {
    makeDefault: true,
    label: "HKRPG Item Sheet"
  });

  // Public API
  globalThis.hkrpg = globalThis.hkrpg ?? {};
  globalThis.hkrpg.rollCheck = rollCheck;
  globalThis.hkrpg.attack = attack;
  globalThis.hkrpg.rollInitiativeForCombatant = rollInitiativeForCombatant;
});

Hooks.on("combatTurn", async (combat, turn, priorTurn) => {
  try {
    // Reset tax for the actor whose turn just ended
    const prior = Number.isInteger(priorTurn) ? combat.turns?.[priorTurn] : null;
    const priorActor = prior?.actor;
    if (priorActor) {
      await resetTurnTax(priorActor);
    }

    // Start-of-turn: restore stamina and set tax = 0
    const current = Number.isInteger(turn) ? combat.turns?.[turn] : null;
    const actor = current?.actor;
    if (!actor) return;

    const { max } = getStamina(actor);
    if (max > 0) await setStamina(actor, max);
    await setTurnTax(actor, 0);

    // Optional info to GM/players? Лучше без спама — оставлю молча.
  } catch (e) {
    console.error("HKRPG | combatTurn error", e);
  }
});

// ----------------------------
// Public: checks and attacks
// ----------------------------
async function rollCheck({ characteristic, skillRank = 0, label = "Проверка" }) {
  const baseDice = Math.floor(characteristic ?? 0);
  const dice = baseDice + Math.floor(skillRank ?? 0);

  if (dice <= 0) {
    ui.notifications.warn(game.i18n.localize("HKRPG.Errors.NoDice"));
    return null;
  }

  return rollSuccessPool({ dice, label });
}

/**
 * Attack according to HKRPG combat rules:
 * - Minimum 1 stamina spent on attack
 * - Dice pool = (Might OR Grace) + weapon quality + invested stamina
 * - Stamina tax: each attack increases the cost of the next attack this turn by +1
 *   The tax is paid, but NOT added to dice pool.
 *
 * @param {object} opts
 * @param {string} opts.weaponId - Item id (weapon) on the actor
 * @param {number} opts.staminaInvested - stamina invested into the attack roll (>=1)
 * @param {Actor} [opts.actor] - if omitted, uses controlled token's actor
 */
async function attack({ weaponId, staminaInvested, actor = null } = {}) {
  actor = actor ?? getActorFromControlledToken();
  if (!actor) {
    ui.notifications.warn(i18n("HKRPG.Errors.InvalidTarget"));
    return null;
  }

  // Basic combat-only sanity: if not in combat, still allow (some groups want it),
  // but tax mechanic is meaningful only in combat.
  const weapon = weaponId ? actor.items.get(weaponId) : null;
  if (!weapon) {
    return warnChat(actor, "HKRPG.Errors.Title", "HKRPG.Errors.WeaponNotSelected");
  }

  staminaInvested = clampInt(staminaInvested, 0, 99);
  if (staminaInvested < 1) {
    return warnChat(actor, "HKRPG.Errors.Title", "HKRPG.Errors.AttackMinStamina");
  }

  const { value: staminaNow } = getStamina(actor);
  const tax = clampInt(getTurnTax(actor), 0, 99);
  const totalCost = staminaInvested + tax;

  if (staminaNow < totalCost) {
    return warnChat(actor, "HKRPG.Errors.Title", "HKRPG.Errors.NotEnoughStaminaForAttack", {
      needed: totalCost,
      have: staminaNow,
      invested: staminaInvested,
      tax
    });
  }

  // Determine melee vs ranged: weapon.system.range.value used in your template.json
  const range = weapon.system?.range?.value ?? "melee"; // melee/reach/ranged
  const isRanged = range === "ranged";

  const might = actor.system?.characteristics?.might?.value ?? 0;
  const grace = actor.system?.characteristics?.grace?.value ?? 0;
  const stat = isRanged ? grace : might;

  const quality = weapon.system?.quality?.value ?? 0;
  const dice = Math.floor(stat) + Math.floor(quality) + staminaInvested;

  // Spend stamina (invested + tax)
  await setStamina(actor, staminaNow - totalCost);

  // Roll attack
  const label = `Атака: ${weapon.name} (${isRanged ? "Грация" : "Мощь"} ${Math.floor(stat)} + Кач ${Math.floor(quality)} + Вл.выносл ${staminaInvested}${tax ? ` + Налог ${tax}` : ""})`;
  const result = await rollSuccessPool({ dice, label });

  // Increase tax for next attack this turn (+1)
  await setTurnTax(actor, tax + 1);

  // Lightweight summary in chat
  await infoChat(
    actor,
    "Стоимость атаки",
    `<p>Потрачено выносливости: <b>${totalCost}</b> (вложено <b>${staminaInvested}</b>, налог <b>${tax}</b>). Следующая атака в этом ходу будет дороже на +${tax + 1}.</p>`
  );

  return result;
}

// ----------------------------
// Extra: initiative helper (optional) — can be used by macros
// ----------------------------
async function rollAllInitiativeInCombat(combat) {
  for (const c of combat.turns ?? []) {
    const init = await rollInitiativeForCombatant(c);
    await c.update({ initiative: init });
  }
}

// Export (ES module)
export {
  rollCheck,
  attack,
  rollInitiativeForCombatant,
  rollAllInitiativeInCombat
};
