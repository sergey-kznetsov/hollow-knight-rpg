/* global ActorSheet, ItemSheet, game, ui, Hooks, ChatMessage, Roll, foundry, Dialog, canvas */

const SYS_ID = "hollow-knight";

function t(key, data) {
  return game.i18n.format(key, data ?? {});
}

async function postMisuse(actor, reasonKey, data) {
  const msg = t(reasonKey, data);
  ui.notifications.warn(msg);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="hkrpg-warn"><b>${t("HKRPG.Chat.MisuseTitle")}</b>: ${msg}</div>`
  });
}

function isMyTurn(actor) {
  const combat = game.combat;
  if (!combat) return true;
  const current = combat.combatant?.actor;
  return current?.id === actor.id;
}

function getEquippedWeapons(actor) {
  return actor.items.filter(i => i.type === "weapon" && i.system?.equipped);
}

function getMaxWeaponInitiativeBonus(actor) {
  const weapons = getEquippedWeapons(actor);
  return weapons.reduce((m, w) => Math.max(m, Number(w.system?.initiativeBonus?.value ?? 0)), 0);
}

async function spendResource(actor, path, amount, errKey) {
  amount = Math.max(0, Number(amount ?? 0));
  if (amount <= 0) return true;

  const current = Number(foundry.utils.getProperty(actor, path) ?? 0);
  if (current < amount) {
    await postMisuse(actor, errKey, { need: amount, have: current });
    return false;
  }
  await actor.update({ [path]: current - amount });
  return true;
}

async function rollSuccessPool({ actor, label, dice, rerolls = 0, flavor = "" }) {
  dice = Math.max(0, Number(dice ?? 0));
  rerolls = Math.max(0, Number(rerolls ?? 0));

  if (dice <= 0) {
    await postMisuse(actor, "HKRPG.Errors.NoDice");
    return null;
  }

  const roll = await new Roll(`${dice}d6cs>=5`).evaluate({ async: true });

  // Мини-перебросы: перебрасываем провалы
  let remaining = rerolls;
  if (remaining > 0) {
    const results = roll.dice[0]?.results ?? [];
    const failuresIdx = results
      .map((r, idx) => ({ r, idx }))
      .filter(x => !x.r.success);

    for (let i = 0; i < Math.min(remaining, failuresIdx.length); i++) {
      const idx = failuresIdx[i].idx;
      const newRoll = await new Roll(`1d6cs>=5`).evaluate({ async: true });
      results[idx] = newRoll.dice[0].results[0];
    }
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
    roll,
    type: CONST.CHAT_MESSAGE_TYPES.ROLL
  });

  return roll;
}

async function rollInitiative(actor) {
  const grace = Number(actor.system?.characteristics?.grace?.value ?? 0);
  const bonus = getMaxWeaponInitiativeBonus(actor) + Number(actor.system?.combat?.initiativeBonus?.value ?? 0);

  // Инициатива = сумма, а не успехи
  const dice = Math.max(0, Math.floor(grace + bonus));
  if (dice <= 0) {
    await postMisuse(actor, "HKRPG.Errors.NoDice");
    return null;
  }

  const roll = await new Roll(`${dice}d6`).evaluate({ async: true });
  const html = await renderTemplate("systems/hollow-knight/chat/roll-card.html", {
    title: t("HKRPG.Chat.Initiative"),
    dice,
    successes: roll.total,
    rerolls: 0,
    flavor: t("HKRPG.Chat.InitiativeFlavor", { grace, bonus })
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: html,
    roll,
    type: CONST.CHAT_MESSAGE_TYPES.ROLL
  });

  await actor.update({ "system.combat.initiative.value": roll.total });
  return roll;
}

async function attackWithWeapon(actor, weapon, investStamina) {
  if (game.combat && !isMyTurn(actor)) {
    await postMisuse(actor, "HKRPG.Errors.NotYourTurn");
    return null;
  }

  investStamina = Math.max(1, Math.floor(Number(investStamina ?? 1)));

  const attacksThisTurn = Number(actor.system?.turn?.attacksThisTurn ?? 0);
  const staminaTax = Math.max(0, attacksThisTurn); // 0/1/2...
  const totalCost = investStamina + staminaTax;

  const ok = await spendResource(actor, "system.pools.stamina.value", totalCost, "HKRPG.Errors.NoStamina");
  if (!ok) return null;

  const quality = Number(weapon.system?.quality?.value ?? 0);
  const isRanged = (weapon.system?.range?.category?.value ?? weapon.system?.range?.value ?? "melee") === "ranged";

  const base = isRanged
    ? Number(actor.system?.characteristics?.grace?.value ?? 0)
    : Number(actor.system?.characteristics?.might?.value ?? 0);

  // ВАЖНО: пока используем чистое качество.
  // Позже (когда начнем улучшения оружия) добавим weapon.system.upgrade.qualityBonus.
  const dice = Math.max(0, Math.floor(base + quality + investStamina));
  const rerolls = Number(weapon.system?.rerolls?.value ?? 0);

  await actor.update({ "system.turn.attacksThisTurn": attacksThisTurn + 1 });

  return rollSuccessPool({
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

async function askAttackDialog(actor) {
  const weapons = getEquippedWeapons(actor);
  if (!weapons.length) {
    await postMisuse(actor, "HKRPG.Errors.NoEquippedWeapons");
    return null;
  }

  const options = weapons
    .map(w => `<option value="${w.id}">${foundry.utils.escapeHTML(w.name)}</option>`)
    .join("");

  return new Promise(resolve => {
    new Dialog({
      title: t("HKRPG.Dialog.AttackTitle"),
      content: `
        <div class="form-group">
          <label>${t("HKRPG.Dialog.Weapon")}</label>
          <select name="weapon">${options}</select>
        </div>
        <div class="form-group">
          <label>${t("HKRPG.Dialog.StaminaInvest")}</label>
          <input type="number" name="invest" value="1" min="1" step="1"/>
        </div>
      `,
      buttons: {
        ok: {
          icon: '<i class="fas fa-dice"></i>',
          label: t("HKRPG.UI.Roll"),
          callback: html => {
            const weaponId = String(html.find('select[name="weapon"]').val());
            const invest = Number(html.find('input[name="invest"]').val() ?? 1);
            resolve({ weaponId, invest });
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: t("HKRPG.UI.Cancel"),
          callback: () => resolve(null)
        }
      },
      default: "ok"
    }).render(true);
  });
}

async function quickDefense(actor, kind) {
  if (game.combat && !isMyTurn(actor)) {
    await postMisuse(actor, "HKRPG.Errors.NotYourTurn");
    return null;
  }

  const value =
    kind === "dodge"
      ? Number(actor.system?.characteristics?.grace?.value ?? 0)
      : Number(actor.system?.characteristics?.might?.value ?? 0);

  const label = kind === "dodge" ? t("HKRPG.Chat.Dodge") : t("HKRPG.Chat.Parry");
  return rollSuccessPool({ actor, label, dice: Math.floor(value) });
}

class HKRPGActorSheet extends ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["hkrpg", "sheet", "actor"],
      width: 780,
      height: 740,
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

    data.equippedWeapons = getEquippedWeapons(this.actor);

    data.itemsByType = this.actor.items.reduce((acc, it) => {
      (acc[it.type] ??= []).push(it);
      return acc;
    }, {});

    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Нажатие по значению характеристики = проверка (быстрый ролл)
    html.find(".characteristic input").on("click", async (ev) => {
      ev.preventDefault();
      const input = ev.currentTarget;
      const key = input.name?.split(".")?.[2];
      const value = parseFloat(input.value) || 0;
      const label = game.i18n.localize(`HKRPG.Actor.Characteristics.${key}`);
      await rollSuccessPool({ actor: this.actor, label: `Проверка: ${label}`, dice: Math.floor(value) });
    });

    html.find("[data-action='roll-init']").on("click", async () => rollInitiative(this.actor));

    // “Атака…” (диалог)
    html.find("[data-action='attack']").on("click", async () => {
      const res = await askAttackDialog(this.actor);
      if (!res) return;
      const weapon = this.actor.items.get(res.weaponId);
      if (!weapon) return postMisuse(this.actor, "HKRPG.Errors.WeaponNotSelected");
      return attackWithWeapon(this.actor, weapon, res.invest);
    });

    // Быстрая атака конкретным оружием (на вкладке “Бой”)
    html.find("[data-action='attack-weapon']").on("click", async (ev) => {
      const itemId = ev.currentTarget.dataset.itemId;
      const weapon = this.actor.items.get(itemId);
      if (!weapon) return;

      const wrap = ev.currentTarget.closest(".hkrpg-row") ?? ev.currentTarget.parentElement;
      const input = wrap?.querySelector("input[data-role='invest']");
      const invest = Number(input?.value ?? 1);

      return attackWithWeapon(this.actor, weapon, invest);
    });

    html.find("[data-action='dodge']").on("click", async () => quickDefense(this.actor, "dodge"));
    html.find("[data-action='parry']").on("click", async () => quickDefense(this.actor, "parry"));

    // Создание предметов
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

    // Быстрый “кости” на строке предмета
    html.find(".item-roll").on("click", async ev => {
      const li = ev.currentTarget.closest("[data-item-id]");
      const item = this.actor.items.get(li.dataset.itemId);
      if (!item) return;

      if (item.type === "weapon") return attackWithWeapon(this.actor, item, 1);
      if (item.type === "spell") {
        const insight = Number(this.actor.system?.characteristics?.insight?.value ?? 0);
        return rollSuccessPool({ actor: this.actor, label: t("HKRPG.Chat.SpellRoll", { spell: item.name }), dice: Math.floor(insight) });
      }
      if (item.type === "art") {
        return ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: this.actor }),
          content: `<div><b>${t("HKRPG.Chat.ArtUsed")}</b>: ${item.name}</div>`
        });
      }
    });
  }
}

class HKRPGItemSheet extends ItemSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["hkrpg", "sheet", "item"],
      width: 560,
      height: 620,
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

  activateListeners(html) {
    super.activateListeners(html);

    // Добавить модификацию (weapon/armor)
    html.find("[data-action='add-mod']").on("click", async (ev) => {
      ev.preventDefault();
      const mods = foundry.utils.duplicate(this.item.system?.mods?.value ?? []);
      mods.push({ name: "", effect: "", price: "", active: true });
      await this.item.update({ "system.mods.value": mods });
    });

    // Удалить модификацию (weapon/armor)
    html.find("[data-action='remove-mod']").on("click", async (ev) => {
      ev.preventDefault();
      const idx = Number(ev.currentTarget.dataset.idx);
      const mods = foundry.utils.duplicate(this.item.system?.mods?.value ?? []);
      if (Number.isNaN(idx) || idx < 0 || idx >= mods.length) return;
      mods.splice(idx, 1);
      await this.item.update({ "system.mods.value": mods });
    });

    // Починка брони: durability.value -> durability.max, broken -> false
    html.find("[data-action='repair-armor']").on("click", async (ev) => {
      ev.preventDefault();
      if (this.item.type !== "armor") return;

      const max = Number(this.item.system?.durability?.max ?? 0);
      await this.item.update({
        "system.durability.value": Math.max(0, max),
        "system.broken.value": false
      });
    });
  }
}

Hooks.once("init", async () => {
  Actors.unregisterSheet("core", ActorSheet);
  Actors.registerSheet(SYS_ID, HKRPGActorSheet, { makeDefault: true });

  Items.unregisterSheet("core", ItemSheet);
  Items.registerSheet(SYS_ID, HKRPGItemSheet, { makeDefault: true });

  // Восстановление выносливости в начале хода и сброс счётчика атак
  Hooks.on("combatTurn", async (combat) => {
    try {
      const actor = combat.combatant?.actor;
      if (!actor) return;

      await actor.update({ "system.turn.attacksThisTurn": 0 });

      const maxSt = Number(actor.system?.pools?.stamina?.max ?? 0);
      if (maxSt > 0) {
        await actor.update({ "system.pools.stamina.value": maxSt });
      }
    } catch (e) {
      console.error("HKRPG | combatTurn hook error", e);
    }
  });
});
