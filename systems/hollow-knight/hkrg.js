/* global ActorSheet, ItemSheet, game, ui, Hooks, ChatMessage, Roll, foundry, Dialog */

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
  return actor.items.filter(i => i.type === "weapon" && (i.system?.equipped === true || i.system?.equipped?.value === true));
}

function getEquippedArmor(actor) {
  const armors = actor.items.filter(i => i.type === "armor" && (i.system?.equipped === true || i.system?.equipped?.value === true));
  return armors[0] ?? null;
}

function armorIsBroken(armor) {
  if (!armor) return false;
  return Boolean(armor.system?.broken?.value ?? armor.system?.broken ?? false) || Number(armor.system?.durability?.value ?? 0) <= 0;
}

function getMaxWeaponInitiativeBonus(actor) {
  const weapons = getEquippedWeapons(actor);
  return weapons.reduce((m, w) => Math.max(m, Number(w.system?.initiativeBonus?.value ?? w.system?.initiativeBonus ?? 0)), 0);
}

function getTargetActorFromUser() {
  const targets = Array.from(game.user.targets ?? []);
  if (targets.length !== 1) return { actor: null, token: null, reason: "HKRPG.Errors.NeedOneTarget" };
  const token = targets[0];
  const actor = token?.actor ?? null;
  if (!actor) return { actor: null, token: null, reason: "HKRPG.Errors.InvalidTarget" };
  return { actor, token, reason: null };
}

async function spendResource(actor, path, amount, errKey, dataForErr) {
  amount = Math.max(0, Number(amount ?? 0));
  if (amount <= 0) return true;

  const current = Number(foundry.utils.getProperty(actor, path) ?? 0);
  if (current < amount) {
    await postMisuse(actor, errKey, dataForErr ?? { need: amount, have: current });
    return false;
  }
  await actor.update({ [path]: current - amount });
  return true;
}

function hasAnySix(roll) {
  try {
    const results = roll?.dice?.[0]?.results ?? [];
    return results.some(r => Number(r.result) === 6);
  } catch {
    return false;
  }
}

/** Поглощение хранится здесь */
function getAbsorptionValue(actor) {
  return Number(foundry.utils.getProperty(actor, "system.combat.absorption.value") ?? 0);
}

/** Поглощение по книге */
function applyAbsorption(remainingDamage, absorptionValue) {
  remainingDamage = Math.max(0, Number(remainingDamage ?? 0));
  absorptionValue = Math.max(0, Number(absorptionValue ?? 0));

  if (remainingDamage <= 0 || absorptionValue <= 0) {
    return { finalDamage: remainingDamage, reducedBy: 0 };
  }

  const reducedBy = 1 + Math.floor(remainingDamage / absorptionValue);
  const finalDamage = Math.max(0, remainingDamage - reducedBy);
  return { finalDamage, reducedBy };
}

async function rollSuccessPool({ actor, label, dice, rerolls = 0, flavor = "", flags = {} }) {
  dice = Math.max(0, Number(dice ?? 0));
  rerolls = Math.max(0, Number(rerolls ?? 0));

  if (dice <= 0) {
    await postMisuse(actor, "HKRPG.Errors.NoDice");
    return null;
  }

  const roll = await new Roll(`${dice}d6cs>=5`).evaluate({ async: true });

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
    type: CONST.CHAT_MESSAGE_TYPES.ROLL,
    flags
  });

  return roll;
}

async function rollInitiative(actor) {
  const grace = Number(actor.system?.characteristics?.grace?.value ?? 0);
  const bonus = getMaxWeaponInitiativeBonus(actor) + Number(actor.system?.combat?.initiativeBonus?.value ?? 0);

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

function getWeaponRangeCategory(weapon) {
  return (weapon.system?.range?.category?.value ?? weapon.system?.range?.value ?? weapon.system?.range ?? "melee");
}

function getWeaponRangeDistance(weapon) {
  return Number(weapon.system?.range?.distance?.value ?? weapon.system?.range?.distance ?? 1);
}

function userCanDefendFor(actor) {
  if (!actor) return false;
  if (game.user.isGM) return true;
  return actor.testUserPermission(game.user, "OWNER");
}

async function maybeOpenDefenseDialog(attackMessageId) {
  const msg = game.messages.get(attackMessageId);
  if (!msg) return;
  const f = msg.flags?.[SYS_ID];
  if (!f || f.kind !== "attack") return;

  // если промах — нечего защищать
  if (!f.hit) return;

  const defender = game.actors.get(f.targetActorId);
  if (!defender) return;
  if (!userCanDefendFor(defender)) return;

  // если защита уже выбрана — не спамим окнами
  if (f.defense || f.soak) return;

  return new Promise(resolve => {
    const content = `
      <p style="margin:0 0 8px;">
        <b>${t("HKRPG.Dialog.DefenseTitle")}</b>
      </p>
      <p style="margin:0 0 8px; color: var(--hk-muted);">
        ${foundry.utils.escapeHTML(f.attackerName)} → <b>${foundry.utils.escapeHTML(f.targetName)}</b> (${foundry.utils.escapeHTML(f.weaponName)})
      </p>
      <p style="margin:0; color: var(--hk-muted);">
        ${t("HKRPG.Dialog.DefenseHint")}
      </p>
    `;

    new Dialog({
      title: t("HKRPG.Dialog.DefenseTitle"),
      content,
      buttons: {
        dodge: {
          icon: '<i class="fas fa-wind"></i>',
          label: t("HKRPG.Chat.Dodge"),
          callback: () => resolve("dodge")
        },
        parry: {
          icon: '<i class="fas fa-shield-alt"></i>',
          label: t("HKRPG.Chat.Parry"),
          callback: () => resolve("parry")
        },
        soak: {
          icon: '<i class="fas fa-shield"></i>',
          label: t("HKRPG.Chat.Soak"),
          callback: () => resolve("soak")
        },
        none: {
          icon: '<i class="fas fa-forward"></i>',
          label: t("HKRPG.Dialog.SkipDefense"),
          callback: () => resolve("none")
        }
      },
      default: "dodge",
      close: () => resolve(null)
    }).render(true);
  }).then(async choice => {
    if (!choice || choice === "none") return;
    await handleAttackCardAction(choice, attackMessageId);
  });
}

async function createDefenseCard({ defender, attackMsg, defenseType, successes, armorName = "", pu = 0 }) {
  const defMsg = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: defender }),
    content: `<div class="hkrpg-defense-card">...</div>`,
    flags: {
      [SYS_ID]: {
        kind: defenseType === "soak" ? "soak" : "defense",
        attackMessageId: attackMsg.id,
        defenseType,
        defenderActorId: defender.id,
        defenderName: defender.name,
        armorName,
        pu,
        successes
      }
    }
  });

  const defHtml = await renderTemplate("systems/hollow-knight/chat/defense-card.html", {
    messageId: defMsg.id,
    attackMessageId: attackMsg.id,
    defenderName: defender.name,
    defenseType,
    successes,
    armorName,
    pu
  });

  await defMsg.update({ content: defHtml });
  return defMsg;
}

async function rollSoak(defender) {
  const armor = getEquippedArmor(defender);
  const broken = armorIsBroken(armor);

  if (!armor || broken) {
    return { armor: armor ?? null, soakSuccesses: 0, pu: 0, roll: null, broken: true };
  }

  const shell = Number(defender.system?.characteristics?.shell?.value ?? 0);
  const soakBonus = Number(armor.system?.soakBonus?.value ?? armor.system?.absorptionBonus?.value ?? armor.system?.absorption?.value ?? 0);
  const rerolls = Number(armor.system?.soakRerolls?.value ?? armor.system?.absorptionRerolls?.value ?? 0);
  const pu = Number(armor.system?.pu?.value ?? armor.system?.pu ?? 0);

  const dice = Math.max(0, Math.floor(shell + soakBonus));
  const roll = await rollSuccessPool({
    actor: defender,
    label: t("HKRPG.Chat.Soak"),
    dice,
    rerolls,
    flavor: `${t("HKRPG.Chat.SoakArmor")}: ${armor.name}\n${t("HKRPG.Chat.PU")}: ${pu}`
  });

  return { armor, soakSuccesses: Number(roll?.total ?? 0), pu, roll, broken: false };
}

async function applyArmorBreakIfNeeded(attackFlags) {
  if (!attackFlags?.attackHasSix) return;
  if (!attackFlags?.hit) return;

  const target = game.actors.get(attackFlags.targetActorId);
  if (!target) return;

  const armor = getEquippedArmor(target);
  if (!armor) return;

  const cur = Number(armor.system?.durability?.value ?? 0);
  const max = Number(armor.system?.durability?.max ?? cur);
  const next = Math.max(0, cur - 1);
  const broken = next <= 0;

  await armor.update({
    "system.durability.value": next,
    "system.durability.max": Math.max(max, 0),
    "system.broken.value": broken
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: target }),
    content: `<div class="hkrpg-warn"><b>${t("HKRPG.Chat.ArmorDamage")}</b>: ${armor.name} (-1 прочность, теперь ${next}/${max})${broken ? ` — <b>${t("HKRPG.Chat.ArmorBroken")}</b>` : ""}</div>`
  });
}

async function applyDamageFromAttack(attackMsg) {
  const f = attackMsg.flags?.[SYS_ID];
  if (!f || f.kind !== "attack") return;

  const attacker = game.actors.get(f.attackerActorId);
  const defender = game.actors.get(f.targetActorId);

  if (!attacker || !defender) {
    if (attacker) await postMisuse(attacker, "HKRPG.Errors.InvalidTarget");
    return;
  }

  // если промах — просто сообщим
  if (!f.hit) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: attacker }),
      content: `<div class="hkrpg-warn"><b>${t("HKRPG.Chat.Result")}</b>: ${t("HKRPG.Chat.Miss")} (${attacker.name} → ${defender.name})</div>`
    });
    return;
  }

  const defenseSuccesses = Number(f.defense?.successes ?? 0);
  const soakSuccesses = Number(f.soak?.successes ?? 0);
  const pu = Number(f.soak?.pu ?? 0);

  const attackSuccesses = Number(f.attackSuccesses ?? 0);
  const netHits = Math.max(0, attackSuccesses - defenseSuccesses);

  const baseDamage = Number(f.baseDamage ?? 0);

  // по книге: max доп. урона = max(база, вложенная выносливость)
  const invest = Number(f.investStamina ?? 0);
  const maxExtra = Math.max(baseDamage, invest);
  const extraDamage = Math.min(netHits, maxExtra);

  let probableDamage = Math.max(0, baseDamage + extraDamage);

  // ПУ: не ниже 1 если урон > 0
  if (probableDamage > 0 && pu > 0) {
    probableDamage = Math.max(1, probableDamage - pu);
  }

  // впитывание
  const afterSoak = Math.max(0, probableDamage - soakSuccesses);

  // поглощение
  const absorptionValue = getAbsorptionValue(defender);
  const absRes = applyAbsorption(afterSoak, absorptionValue);
  const finalDamage = absRes.finalDamage;
  const absorbedBy = absRes.reducedBy;

  if (finalDamage > 0) {
    const curHearts = Number(defender.system?.pools?.hearts?.value ?? 0);
    const nextHearts = Math.max(0, curHearts - finalDamage);
    await defender.update({ "system.pools.hearts.value": nextHearts });
  }

  await applyArmorBreakIfNeeded(f);

  const report = await renderTemplate("systems/hollow-knight/chat/damage-report.html", {
    attackerName: attacker.name,
    defenderName: defender.name,
    weaponName: f.weaponName,
    attackSuccesses,
    defenseSuccesses,
    netHits,
    baseDamage,
    invest,
    maxExtra,
    extraDamage,
    pu,
    soakSuccesses,
    absorptionValue,
    absorbedBy,
    finalDamage
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    content: report
  });
}

async function createAttackCard({ attacker, target, weapon, investStamina, staminaTax, totalCost, roll }) {
  const attackSuccesses = Number(roll?.total ?? 0);
  const attackHasSix = hasAnySix(roll);
  const range = getWeaponRangeCategory(weapon);
  const rangeDistance = getWeaponRangeDistance(weapon);

  const hit = attackSuccesses > 0;

  const flags = {
    [SYS_ID]: {
      kind: "attack",
      attackerActorId: attacker.id,
      attackerName: attacker.name,

      targetActorId: target.id,
      targetName: target.name,

      weaponItemId: weapon.id,
      weaponName: weapon.name,
      weaponType: weapon.system?.type?.value ?? weapon.system?.type ?? "",
      baseDamage: Number(weapon.system?.damage?.value ?? weapon.system?.damage ?? 0),
      quality: Number(weapon.system?.quality?.value ?? weapon.system?.quality ?? 0),

      range,
      rangeDistance,

      investStamina,
      staminaTax,
      totalCost,

      attackSuccesses,
      attackHasSix,
      hit,

      defense: null,
      soak: null
    }
  };

  const msg = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    content: `<div class="hkrpg-attack-card">...</div>`,
    flags
  });

  const html = await renderTemplate("systems/hollow-knight/chat/attack-card.html", {
    messageId: msg.id,
    attackerName: attacker.name,
    targetName: target.name,
    weaponName: weapon.name,
    attackSuccesses,
    baseDamage: Number(weapon.system?.damage?.value ?? 0),
    range,
    rangeDistance,
    investStamina,
    staminaTax,
    totalCost,
    hit
  });

  await msg.update({ content: html });

  // ВАЖНО: если попал — покажем диалог защиты владельцу цели/ГМу
  if (hit) {
    // запускаем на стороне всех клиентов, но реально откроется только у того, кто может защищаться
    setTimeout(() => maybeOpenDefenseDialog(msg.id), 150);
  }

  return msg;
}

async function attackWithWeapon(attacker, weapon, investStamina) {
  if (game.combat && !isMyTurn(attacker)) {
    await postMisuse(attacker, "HKRPG.Errors.NotYourTurn");
    return null;
  }

  const tgt = getTargetActorFromUser();
  if (!tgt.actor) {
    await postMisuse(attacker, tgt.reason);
    return null;
  }
  const target = tgt.actor;

  investStamina = Math.max(1, Math.floor(Number(investStamina ?? 1)));

  const attacksThisTurn = Number(attacker.system?.turn?.attacksThisTurn ?? 0);
  const staminaTax = Math.max(0, attacksThisTurn);
  const totalCost = investStamina + staminaTax;

  const ok = await spendResource(
    attacker,
    "system.pools.stamina.value",
    totalCost,
    "HKRPG.Errors.NotEnoughStaminaForAttack",
    { need: totalCost, have: Number(attacker.system?.pools?.stamina?.value ?? 0) }
  );
  if (!ok) return null;

  const quality = Number(weapon.system?.quality?.value ?? weapon.system?.quality ?? 0);
  const isRanged = getWeaponRangeCategory(weapon) === "ranged";

  const base = isRanged
    ? Number(attacker.system?.characteristics?.grace?.value ?? 0)
    : Number(attacker.system?.characteristics?.might?.value ?? 0);

  const dice = Math.max(0, Math.floor(base + quality + investStamina));
  const rerolls = Number(weapon.system?.rerolls?.value ?? weapon.system?.rerolls ?? 0);

  await attacker.update({ "system.turn.attacksThisTurn": attacksThisTurn + 1 });

  const roll = await new Roll(`${dice}d6cs>=5`).evaluate({ async: true });

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

  await createAttackCard({
    attacker,
    target,
    weapon,
    investStamina,
    staminaTax,
    totalCost,
    roll
  });

  return roll;
}

/* ---------- Chat actions (единая точка) ---------- */

async function handleAttackCardAction(action, attackMessageId) {
  const attackMsg = game.messages.get(attackMessageId);
  if (!attackMsg) return;

  const f = attackMsg.flags?.[SYS_ID];
  if (!f || f.kind !== "attack") return;

  const defender = game.actors.get(f.targetActorId);
  if (!defender) return;

  if (action === "dodge" || action === "parry") {
    if (game.combat && !isMyTurn(defender)) {
      await postMisuse(defender, "HKRPG.Errors.NotYourTurn");
      return;
    }

    const value =
      action === "dodge"
        ? Number(defender.system?.characteristics?.grace?.value ?? 0)
        : Number(defender.system?.characteristics?.might?.value ?? 0);

    const label = action === "dodge" ? t("HKRPG.Chat.Dodge") : t("HKRPG.Chat.Parry");
    const roll = await rollSuccessPool({ actor: defender, label, dice: Math.floor(value) });
    const successes = Number(roll?.total ?? 0);

    await createDefenseCard({ defender, attackMsg, defenseType: action, successes });

    await attackMsg.update({
      [`flags.${SYS_ID}.defense`]: { type: action, actorId: defender.id, successes }
    });

    ui.notifications.info(t("HKRPG.Chat.DefenseSaved"));
    return;
  }

  if (action === "soak") {
    const res = await rollSoak(defender);

    if (res.broken) {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: defender }),
        content: `<div class="hkrpg-warn"><b>${t("HKRPG.Chat.Soak")}</b>: ${t("HKRPG.Errors.ArmorBrokenNoSoak")}</div>`
      });
    }

    await createDefenseCard({
      defender,
      attackMsg,
      defenseType: "soak",
      successes: res.soakSuccesses,
      armorName: res.armor?.name ?? "",
      pu: res.pu
    });

    await attackMsg.update({
      [`flags.${SYS_ID}.soak`]: {
        actorId: defender.id,
        armorId: res.armor?.id ?? null,
        armorName: res.armor?.name ?? "",
        successes: res.soakSuccesses,
        pu: res.pu
      }
    });

    ui.notifications.info(t("HKRPG.Chat.SoakSaved"));
    return;
  }

  if (action === "apply-damage") {
    await applyDamageFromAttack(attackMsg);
  }
}

/* ---------- Sheets ---------- */

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
    return `systems/hollow-knight/templates/actor/${this.actor.type}-sheet.html`;
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

    html.find(".characteristic input").on("click", async (ev) => {
      ev.preventDefault();
      const input = ev.currentTarget;
      const key = input.name?.split(".")?.[2];
      const value = parseFloat(input.value) || 0;
      const label = game.i18n.localize(`HKRPG.Actor.Characteristics.${key}`);
      await rollSuccessPool({ actor: this.actor, label: `Проверка: ${label}`, dice: Math.floor(value) });
    });

    html.find("[data-action='roll-init']").on("click", async () => rollInitiative(this.actor));

    html.find("[data-action='attack']").on("click", async () => {
      const res = await askAttackDialog(this.actor);
      if (!res) return;
      const weapon = this.actor.items.get(res.weaponId);
      if (!weapon) return postMisuse(this.actor, "HKRPG.Errors.WeaponNotSelected");
      return attackWithWeapon(this.actor, weapon, res.invest);
    });

    html.find("[data-action='attack-weapon']").on("click", async (ev) => {
      const itemId = ev.currentTarget.dataset.itemId;
      const weapon = this.actor.items.get(itemId);
      if (!weapon) return;

      const wrap = ev.currentTarget.closest(".hkrpg-row") ?? ev.currentTarget.parentElement;
      const input = wrap?.querySelector("input[data-role='invest']");
      const invest = Number(input?.value ?? 1);

      return attackWithWeapon(this.actor, weapon, invest);
    });

    html.find("[data-action='dodge']").on("click", async () => {
      const value = Number(this.actor.system?.characteristics?.grace?.value ?? 0);
      await rollSuccessPool({ actor: this.actor, label: t("HKRPG.Chat.Dodge"), dice: Math.floor(value) });
    });

    html.find("[data-action='parry']").on("click", async () => {
      const value = Number(this.actor.system?.characteristics?.might?.value ?? 0);
      await rollSuccessPool({ actor: this.actor, label: t("HKRPG.Chat.Parry"), dice: Math.floor(value) });
    });

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

      const cur = Boolean(item.system?.equipped?.value ?? item.system?.equipped ?? false);
      if (item.system?.equipped?.value !== undefined) {
        await item.update({ "system.equipped.value": !cur });
      } else {
        await item.update({ "system.equipped": !cur });
      }
    });

    html.find(".item-roll").on("click", async ev => {
      const li = ev.currentTarget.closest("[data-item-id]");
      const item = this.actor.items.get(li.dataset.itemId);
      if (!item) return;

      if (item.type === "weapon") return attackWithWeapon(this.actor, item, 1);

      if (item.type === "spell") {
        const insight = Number(this.actor.system?.characteristics?.insight?.value ?? 0);
        return rollSuccessPool({ actor: this.actor, label: t("HKRPG.Chat.SpellRoll", { spell: item.name }), dice: Math.floor(insight) });
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

    html.find("[data-action='add-mod']").on("click", async (ev) => {
      ev.preventDefault();
      const mods = foundry.utils.duplicate(this.item.system?.mods?.value ?? this.item.system?.mods ?? []);
      mods.push({ name: "", effect: "", price: "", active: true });
      if (this.item.system?.mods?.value !== undefined) await this.item.update({ "system.mods.value": mods });
      else await this.item.update({ "system.mods": mods });
    });

    html.find("[data-action='remove-mod']").on("click", async (ev) => {
      ev.preventDefault();
      const idx = Number(ev.currentTarget.dataset.idx);
      const mods = foundry.utils.duplicate(this.item.system?.mods?.value ?? this.item.system?.mods ?? []);
      if (Number.isNaN(idx) || idx < 0 || idx >= mods.length) return;
      mods.splice(idx, 1);
      if (this.item.system?.mods?.value !== undefined) await this.item.update({ "system.mods.value": mods });
      else await this.item.update({ "system.mods": mods });
    });

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

/* ---------- Chat listeners ---------- */

Hooks.on("renderChatMessage", (message, html) => {
  // клики по кнопкам атаки
  html.find("[data-hkrpg-action]").on("click", async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    const action = btn.dataset.hkrpgAction;
    const msgId = btn.dataset.messageId;
    await handleAttackCardAction(action, msgId);
  });
});

/* ---------- Init ---------- */

Hooks.once("init", async () => {
  Actors.unregisterSheet("core", ActorSheet);
  Actors.registerSheet(SYS_ID, HKRPGActorSheet, { makeDefault: true });

  Items.unregisterSheet("core", ItemSheet);
  Items.registerSheet(SYS_ID, HKRPGItemSheet, { makeDefault: true });

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
