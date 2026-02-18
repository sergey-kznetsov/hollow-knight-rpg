/* global ActorSheet, ItemSheet, game, ui, Hooks, ChatMessage, Roll, foundry */

const HKRPG = {
  id: "hollow-knight",
  roll: {
    // Успехи: 5-6
    successTarget: 5
  }
};

function t(key, data) {
  return game.i18n.format(key, data ?? {});
}

function isMyTurn(actor) {
  const combat = game.combat;
  if (!combat) return true;
  const current = combat.combatant?.actor;
  return current?.id === actor.id;
}

async function postMisuse(actor, reasonKey, data) {
  const msg = t(reasonKey, data);
  ui.notifications.warn(msg);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="hkrpg-warn"><b>${t("HKRPG.Chat.MisuseTitle")}</b>: ${msg}</div>`
  });
}

function getEquippedWeapons(actor) {
  return actor.items.filter(i => i.type === "weapon" && i.system?.equipped);
}

function getInitiativeBonus(actor) {
  // В книге бонусы инициативы есть у оружия; “не суммируется с другими бонусами от оружия”
  // Поэтому берём максимум среди экипированных оружий.
  const weapons = getEquippedWeapons(actor);
  const maxWeaponBonus = weapons.reduce((m, w) => Math.max(m, Number(w.system?.initiativeBonus?.value ?? 0)), 0);
  return maxWeaponBonus;
}

async function rollDicePool({ actor, label, dice, rerolls = 0, flavor = "" }) {
  dice = Math.max(0, Number(dice ?? 0));
  rerolls = Math.max(0, Number(rerolls ?? 0));

  if (dice <= 0) {
    await postMisuse(actor, "HKRPG.Errors.NoDice");
    return null;
  }

  // d6cs>=5 считает успехи в Foundry, total = количество успехов
  const roll = await new Roll(`${dice}d6cs>=${HKRPG.roll.successTarget}`).evaluate({ async: true });

  // Простейшая реализация “перебросов”: перебрасываем 1 неуспех за 1 переброс.
  // Это не “идеальная математика” книги для всех случаев, но работает как механизм.
  // Если захочешь — потом заменим на более точные источники перебросов/лимитов.
  let remaining = rerolls;
  if (remaining > 0) {
    const results = roll.dice[0]?.results ?? [];
    const failuresIdx = results
      .map((r, idx) => ({ r, idx }))
      .filter(x => !x.r.success);

    for (let i = 0; i < Math.min(remaining, failuresIdx.length); i++) {
      const idx = failuresIdx[i].idx;
      const newRoll = await new Roll(`1d6cs>=${HKRPG.roll.successTarget}`).evaluate({ async: true });
      results[idx] = newRoll.dice[0].results[0];
    }
    // пересчёт total
    roll._total = results.filter(r => r.success).length;
  }

  const html = await renderTemplate("systems/hollow-knight/chat/roll-card.html", {
    title: label,
    dice,
    successes: roll.total,
    rerolls,
    flavor
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: html,
    roll: roll,
    type: CONST.CHAT_MESSAGE_TYPES.ROLL
  });

  return roll;
}

async function rollInitiative(actor) {
  const grace = Number(actor.system?.characteristics?.grace?.value ?? 0);
  const bonus = getInitiativeBonus(actor) + Number(actor.system?.combat?.initiativeBonus?.value ?? 0);

  // В книге инициатива — сумма результата, а не успехи :contentReference[oaicite:5]{index=5}
  const dice = Math.max(0, grace + bonus);
  if (dice <= 0) {
    await postMisuse(actor, "HKRPG.Errors.NoDice");
    return null;
  }

  const roll = await new Roll(`${dice}d6`).evaluate({ async: true });
  const html = await renderTemplate("systems/hollow-knight/chat/roll-card.html", {
    title: t("HKRPG.Chat.Initiative"),
    dice,
    successes: roll.total, // тут это “значение инициативы”, не успехи
    rerolls: 0,
    flavor: t("HKRPG.Chat.InitiativeFlavor", { grace, bonus })
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: html,
    roll: roll,
    type: CONST.CHAT_MESSAGE_TYPES.ROLL
  });

  await actor.update({ "system.combat.initiative.value": roll.total });
  return roll;
}

async function spendResource(actor, path, amount, errKey) {
  amount = Number(amount ?? 0);
  if (amount <= 0) return true;

  const current = Number(foundry.utils.getProperty(actor, path) ?? 0);
  if (current < amount) {
    await postMisuse(actor, errKey, { need: amount, have: current });
    return false;
  }
  await actor.update({ [path]: current - amount });
  return true;
}

async function attackWithWeapon(actor, weapon) {
  if (game.combat && !isMyTurn(actor)) {
    await postMisuse(actor, "HKRPG.Errors.NotYourTurn");
    return;
  }

  // Диалог: сколько выносливости вложить (минимум 1)
  const invest = await new Promise(resolve => {
    new Dialog({
      title: t("HKRPG.Dialog.AttackTitle"),
      content: `
        <div class="form-group">
          <label>${t("HKRPG.Dialog.StaminaInvest")}</label>
          <input type="number" name="invest" value="1" min="1" step="1"/>
        </div>
      `,
      buttons: {
        ok: {
          icon: '<i class="fas fa-check"></i>',
          label: t("HKRPG.UI.Roll"),
          callback: html => resolve(Number(html.find('input[name="invest"]').val() ?? 1))
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: t("HKRPG.UI.Cancel"), callback: () => resolve(null) }
      },
      default: "ok"
    }).render(true);
  });

  if (invest == null) return;
  const investStamina = Math.max(1, Math.floor(invest));

  // Налог выносливости на повторные атаки в тот же ход :contentReference[oaicite:6]{index=6}
  const attacksThisTurn = Number(actor.system?.turn?.attacksThisTurn ?? 0);
  const staminaTax = Math.max(0, attacksThisTurn); // первая атака: 0, вторая: 1, третья: 2 ...

  const totalCost = investStamina + staminaTax;

  const ok = await spendResource(actor, "system.pools.stamina.value", totalCost, "HKRPG.Errors.NoStamina");
  if (!ok) return;

  const quality = Number(weapon.system?.quality?.value ?? 0);
  const isRanged = (weapon.system?.range?.value ?? "melee") === "ranged";

  // В книге: рукопашная — Мощь, дистанционная — Грация :contentReference[oaicite:7]{index=7}
  const base = isRanged
    ? Number(actor.system?.characteristics?.grace?.value ?? 0)
    : Number(actor.system?.characteristics?.might?.value ?? 0);

  const dice = Math.max(0, base + quality + investStamina);
  const rerolls = Number(weapon.system?.rerolls?.value ?? 0);

  await actor.update({ "system.turn.attacksThisTurn": attacksThisTurn + 1 });

  await rollDicePool({
    actor,
    label: t("HKRPG.Chat.AttackRoll", { weapon: weapon.name }),
    dice,
    rerolls,
    flavor: t("HKRPG.Chat.AttackFlavor", {
      mode: isRanged ? t("HKRPG.Chat.Ranged") : t("HKRPG.Chat.Melee"),
      base,
      quality,
      invest: investStamina,
      tax: staminaTax,
      cost: totalCost
    })
  });
}

async function castSpell(actor, spell) {
  if (game.combat && !isMyTurn(actor)) {
    await postMisuse(actor, "HKRPG.Errors.NotYourTurn");
    return;
  }
  const costSoul = Number(spell.system?.costSoul?.value ?? 0);
  const ok = await spendResource(actor, "system.pools.soul.value", costSoul, "HKRPG.Errors.NoSoul");
  if (!ok) return;

  const insight = Number(actor.system?.characteristics?.insight?.value ?? 0);
  const complexity = Number(spell.system?.complexity?.value ?? 0);
  // Здесь я использую “минимальную” механику: пул = Проницательность + (возможные моды позже)
  const dice = Math.max(0, insight);

  await rollDicePool({
    actor,
    label: t("HKRPG.Chat.SpellRoll", { spell: spell.name }),
    dice,
    rerolls: 0,
    flavor: t("HKRPG.Chat.SpellFlavor", { insight, complexity, costSoul })
  });
}

async function useArt(actor, art) {
  if (game.combat && !isMyTurn(actor)) {
    await postMisuse(actor, "HKRPG.Errors.NotYourTurn");
    return;
  }
  const costStamina = Number(art.system?.costStamina?.value ?? 0);
  const costSoul = Number(art.system?.costSoul?.value ?? 0);

  const okSt = await spendResource(actor, "system.pools.stamina.value", costStamina, "HKRPG.Errors.NoStamina");
  if (!okSt) return;
  const okSo = await spendResource(actor, "system.pools.soul.value", costSoul, "HKRPG.Errors.NoSoul");
  if (!okSo) return;

  // Большинство искусств — это “применение” + возможные проверки: оставляем как карточку/сообщение.
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div><b>${t("HKRPG.Chat.ArtUsed")}</b>: ${art.name}<br/>
      <span>${t("HKRPG.Chat.Cost")}: ${t("HKRPG.Actor.Pools.stamina")} ${costStamina}, ${t("HKRPG.Actor.Pools.soul")} ${costSoul}</span>
    </div>`
  });
}

class HKRPGActorSheet extends ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["hkrpg", "sheet", "actor"],
      width: 760,
      height: 720,
      tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "stats" }]
    });
  }

  get template() {
    const type = this.actor.type;
    return `systems/hollow-knight/templates/actor/${type}-sheet.html`;
  }

  async getData(options) {
    const data = await super.getData(options);
    data.system = this.actor.system;
    data.itemsByType = this.actor.items.reduce((acc, it) => {
      (acc[it.type] ??= []).push(it);
      return acc;
    }, {});
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action='roll-init']").on("click", async () => rollInitiative(this.actor));

    html.find("[data-action='item-create']").on("click", async (ev) => {
      const type = ev.currentTarget.dataset.type;
      await this.actor.createEmbeddedDocuments("Item", [{ name: t(`HKRPG.Item.Types.${type}`), type }]);
    });

    html.find(".item-edit").on("click", ev => {
      const li = ev.currentTarget.closest("[data-item-id]");
      this.actor.items.get(li.dataset.itemId)?.sheet?.render(true);
    });

    html.find(".item-delete").on("click", async ev => {
      const li = ev.currentTarget.closest("[data-item-id]");
      await this.actor.deleteEmbeddedDocuments("Item", [li.dataset.itemId]);
    });

    html.find(".item-toggle-equipped").on("click", async ev => {
      const li = ev.currentTarget.closest("[data-item-id]");
      const item = this.actor.items.get(li.dataset.itemId);
      if (!item) return;
      await item.update({ "system.equipped": !item.system.equipped });
    });

    html.find(".item-roll").on("click", async ev => {
      const li = ev.currentTarget.closest("[data-item-id]");
      const item = this.actor.items.get(li.dataset.itemId);
      if (!item) return;

      if (item.type === "weapon") return attackWithWeapon(this.actor, item);
      if (item.type === "spell") return castSpell(this.actor, item);
      if (item.type === "art") return useArt(this.actor, item);
    });
  }
}

class HKRPGItemSheet extends ItemSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["hkrpg", "sheet", "item"],
      width: 520,
      height: 540,
      tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "details" }]
    });
  }

  get template() {
    return `systems/hollow-knight/templates/item/${this.item.type}-sheet.html`;
  }

  async getData(options) {
    const data = await super.getData(options);
    data.system = this.item.system;
    return data;
  }
}

Hooks.once("init", async () => {
  game.HKRPG = HKRPG;

  Actors.unregisterSheet("core", ActorSheet);
  Actors.registerSheet("hollow-knight", HKRPGActorSheet, { makeDefault: true });

  Items.unregisterSheet("core", ItemSheet);
  Items.registerSheet("hollow-knight", HKRPGItemSheet, { makeDefault: true });

  // чтобы “налог атак” сбрасывался при смене хода
  Hooks.on("updateCombat", async (combat, changed) => {
    if (!("turn" in changed) && !("round" in changed)) return;

    // Сбрасываем счётчик атак у текущего активного актёра (на старте его хода)
    const actor = combat.combatant?.actor;
    if (actor) await actor.update({ "system.turn.attacksThisTurn": 0 });
  });
});
